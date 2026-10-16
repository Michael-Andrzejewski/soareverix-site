#!/usr/bin/env python3
"""4x super-resolution with Real-ESRGAN, without PyTorch.

    python3 superres.py in.png out.png [--weights RealESRGAN_x4plus.pth] [--tile 256]

Cloud containers often cannot install torch (its wheel index is blocked), but
PyPI's onnxruntime and onnx install fine. This script reads the .pth weights with a
small custom unpickler (torch's zip format: data.pkl plus raw storages), builds the
RRDBNet graph (23 RRDB blocks, 64 features, grow 32, x4) as ONNX in memory and runs
it with onnxruntime in overlapping tiles.

Weights (67 MB, BSD-3-Clause, xinntao/Real-ESRGAN):
  https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth

Use it on the source before decomposing: GAN upscaling invents crisp detail
(stars, cloud texture, edges), where Lanczos only enlarges the blur. Check the
result at 1:1 for invented artefacts; blend back some Lanczos (--mix) if needed.
"""
import argparse
import pickle
import time
import zipfile

import numpy as np
from PIL import Image

DTYPES = {"FloatStorage": np.float32, "HalfStorage": np.float16, "DoubleStorage": np.float64,
          "LongStorage": np.int64, "IntStorage": np.int32}


def load_pth(path):
    """state dict of numpy arrays from a torch zip checkpoint, without torch."""
    zf = zipfile.ZipFile(path)
    root = zf.namelist()[0].split("/")[0]
    cache = {}

    class Storage:
        def __init__(self, name):
            self.name = name

    def rebuild(storage, offset, size, stride, *_):
        dt, key = storage
        if key not in cache:
            cache[key] = np.frombuffer(zf.read(f"{root}/data/{key}"), dtype=dt)
        flat = cache[key]
        if not size:
            return flat[offset:offset + 1].reshape(())
        arr = np.lib.stride_tricks.as_strided(flat[offset:], shape=size,
                                              strides=[s * flat.itemsize for s in stride])
        return np.array(arr)

    class Unpickler(pickle.Unpickler):
        def find_class(self, mod, name):
            if mod == "torch._utils" and name == "_rebuild_tensor_v2":
                return rebuild
            if mod == "torch" and name in DTYPES:
                return Storage(name)
            if mod == "collections" and name == "OrderedDict":
                import collections
                return collections.OrderedDict
            return super().find_class(mod, name)

        def persistent_load(self, pid):
            _, stype, key, _loc, _n = pid
            return (DTYPES[stype.name], key)

    obj = Unpickler(zf.open(f"{root}/data.pkl")).load()
    for k in ("params_ema", "params"):
        if isinstance(obj, dict) and k in obj:
            return obj[k]
    return obj


def build_rrdbnet(sd, num_block=23):
    import onnx
    from onnx import TensorProto, helper, numpy_helper
    nodes, inits = [], []
    count = [0]

    def name(p):
        count[0] += 1
        return f"{p}_{count[0]}"

    def conv(x, key):
        w, b = sd[key + ".weight"], sd[key + ".bias"]
        inits.append(numpy_helper.from_array(w.astype(np.float32), key + ".weight"))
        inits.append(numpy_helper.from_array(b.astype(np.float32), key + ".bias"))
        y = name("conv")
        nodes.append(helper.make_node("Conv", [x, key + ".weight", key + ".bias"], [y], pads=[1, 1, 1, 1],
                                      kernel_shape=[3, 3]))
        return y

    def lrelu(x):
        y = name("lrelu")
        nodes.append(helper.make_node("LeakyRelu", [x], [y], alpha=0.2))
        return y

    def cat(xs):
        y = name("cat")
        nodes.append(helper.make_node("Concat", xs, [y], axis=1))
        return y

    def add(a, b):
        y = name("add")
        nodes.append(helper.make_node("Add", [a, b], [y]))
        return y

    def scale(x):
        y = name("mul")
        nodes.append(helper.make_node("Mul", [x, "c02"], [y]))
        return y

    def up(x):
        y = name("up")
        nodes.append(helper.make_node("Resize", [x, "", "scales2"], [y], mode="nearest",
                                      coordinate_transformation_mode="asymmetric", nearest_mode="floor"))
        return y

    inits.append(numpy_helper.from_array(np.array(0.2, np.float32), "c02"))
    inits.append(numpy_helper.from_array(np.array([1, 1, 2, 2], np.float32), "scales2"))

    def rdb(x, p):
        x1 = lrelu(conv(x, p + ".conv1"))
        x2 = lrelu(conv(cat([x, x1]), p + ".conv2"))
        x3 = lrelu(conv(cat([x, x1, x2]), p + ".conv3"))
        x4 = lrelu(conv(cat([x, x1, x2, x3]), p + ".conv4"))
        x5 = conv(cat([x, x1, x2, x3, x4]), p + ".conv5")
        return add(scale(x5), x)

    feat = conv("input", "conv_first")
    h = feat
    for i in range(num_block):
        p = f"body.{i}"
        o = rdb(rdb(rdb(h, p + ".rdb1"), p + ".rdb2"), p + ".rdb3")
        h = add(scale(o), h)
    feat = add(feat, conv(h, "conv_body"))
    feat = lrelu(conv(up(feat), "conv_up1"))
    feat = lrelu(conv(up(feat), "conv_up2"))
    out = conv(lrelu(conv(feat, "conv_hr")), "conv_last")
    nodes[-1].output[0] = "output"
    g = helper.make_graph(nodes, "rrdbnet",
                          [helper.make_tensor_value_info("input", TensorProto.FLOAT, [1, 3, None, None])],
                          [helper.make_tensor_value_info("output", TensorProto.FLOAT, [1, 3, None, None])], inits)
    model = helper.make_model(g, opset_imports=[helper.make_opsetid("", 17)])
    model.ir_version = 8
    return model.SerializeToString()


def upscale4(img, weights, tile=256, pad=16, threads=0):
    """uint8 RGB HxWx3 -> uint8 RGB 4Hx4Wx3."""
    import onnxruntime as ort
    so = ort.SessionOptions()
    if threads:
        so.intra_op_num_threads = threads
    sess = ort.InferenceSession(build_rrdbnet(load_pth(weights)), so, providers=["CPUExecutionProvider"])
    x = img.astype(np.float32) / 255.0
    H, W = x.shape[:2]
    out = np.zeros((H * 4, W * 4, 3), np.float32)
    for y0 in range(0, H, tile):
        for x0 in range(0, W, tile):
            y1, x1 = min(H, y0 + tile), min(W, x0 + tile)
            py0, px0, py1, px1 = max(0, y0 - pad), max(0, x0 - pad), min(H, y1 + pad), min(W, x1 + pad)
            inp = np.ascontiguousarray(x[py0:py1, px0:px1].transpose(2, 0, 1)[None])
            res = sess.run(None, {"input": inp})[0][0].transpose(1, 2, 0)
            oy, ox = (y0 - py0) * 4, (x0 - px0) * 4
            out[y0 * 4:y1 * 4, x0 * 4:x1 * 4] = res[oy:oy + (y1 - y0) * 4, ox:ox + (x1 - x0) * 4]
    return np.clip(np.round(out * 255), 0, 255).astype(np.uint8)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("out")
    ap.add_argument("--weights", default="RealESRGAN_x4plus.pth")
    ap.add_argument("--tile", type=int, default=256)
    ap.add_argument("--mix", type=float, default=0.0, help="blend this much Lanczos back in (0..1)")
    a = ap.parse_args()
    img = np.asarray(Image.open(a.src).convert("RGB"))
    t0 = time.time()
    up = upscale4(img, a.weights, a.tile)
    if a.mix:
        lz = np.asarray(Image.fromarray(img).resize((up.shape[1], up.shape[0]), Image.LANCZOS)).astype(np.float32)
        up = np.clip(np.round(up * (1 - a.mix) + lz * a.mix), 0, 255).astype(np.uint8)
    Image.fromarray(up).save(a.out)
    print(f"{a.src} {img.shape[1]}x{img.shape[0]} -> {up.shape[1]}x{up.shape[0]} in {time.time() - t0:.0f} s")


if __name__ == "__main__":
    main()
