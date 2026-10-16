#!/usr/bin/env python3
"""Inline a page's local <script src> files into one self-contained HTML file.

    python3 bundle.py art/ascension/index.html out.html            # standalone page
    python3 bundle.py art/ascension/index.html out.html --fragment # for the Artifact tool

--fragment drops <!doctype>, <html>, <head>, <body> wrappers (the Artifact publish
step adds its own skeleton) and keeps <title>, <meta>, <link>, <style> and content.
"""
import argparse
import os
import re


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("page")
    ap.add_argument("out")
    ap.add_argument("--fragment", action="store_true")
    a = ap.parse_args()
    base = os.path.dirname(os.path.abspath(a.page))
    html = open(a.page, encoding="utf-8").read()

    def inline(m):
        src = m.group(1)
        if re.match(r"^(https?:)?//", src):
            return m.group(0)
        code = open(os.path.join(base, src), encoding="utf-8").read()
        return "<script>\n" + code.replace("</script", "<\\/script") + "\n</script>"

    html = re.sub(r'<script src="([^"]+)"></script>', inline, html)
    if a.fragment:
        html = re.sub(r"<!doctype html>\s*", "", html, flags=re.I)
        html = re.sub(r"</?(html|head|body)(\s[^>]*)?>\s*", "", html, flags=re.I)
        # the publish skeleton already provides charset + viewport
        html = re.sub(r'<meta (charset|name="viewport")[^>]*>\s*', "", html)
    with open(a.out, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"wrote {a.out} ({os.path.getsize(a.out) / 1e6:.2f} MB)")


if __name__ == "__main__":
    main()
