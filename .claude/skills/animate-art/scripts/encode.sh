#!/usr/bin/env bash
# Encode a PNG frame sequence (f00000.png ...) into a web-friendly, seamlessly looping MP4.
#   encode.sh <framesdir> <out.mp4> [fps=60] [crf=15]
# Odd sizes are padded to even (H.264 4:2:0 needs it) by smearing the last column/row,
# so no coloured seam appears. RGB->YUV uses the BT.709 matrix and the stream is tagged
# BT.709 to match; otherwise ffmpeg converts with BT.601 and players shift colours.
# Also writes <out>.poster.png (frame 0).
set -euo pipefail
frames=${1:?framesdir}; out=${2:?out.mp4}; fps=${3:-60}; crf=${4:-15}
ffmpeg -y -loglevel error -framerate "$fps" -i "$frames/f%05d.png" \
  -vf "pad=ceil(iw/2)*2:ceil(ih/2)*2:0:0,fillborders=right=1:bottom=1:mode=smear,scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd+full_chroma_int,format=yuv420p" \
  -c:v libx264 -preset slow -crf "$crf" -colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv \
  -movflags +faststart "$out"
cp "$frames/f00000.png" "${out%.mp4}.poster.png"
ffprobe -v error -show_entries stream=width,height,r_frame_rate,nb_frames -show_entries format=duration,size -of compact "$out"
