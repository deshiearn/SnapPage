#!/usr/bin/env python3
"""Rebuild the slim Font Awesome subset (assets/fonts/fa-*.woff + assets/css/icons.css).
Run after adding any new fa-* icon to index.html or assets/js/*.js:
    FA_DIR=/path/to/fontawesome-free python3 tools/build-icons.py
FA_DIR must contain css/fontawesome.css and webfonts/fa-solid-900.ttf + fa-regular-400.ttf (Font Awesome Free 6.x)."""
import os, re, glob, subprocess, sys, hashlib
from fontTools.ttLib import TTFont
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FA = os.environ.get('FA_DIR', '/tmp/tools/fa')
src = ''.join(open(f, encoding='utf8').read() for f in glob.glob(ROOT + '/assets/js/*.js') + [ROOT + '/index.html', ROOT + '/indexadmin.html'])
old = open(ROOT + '/assets/css/icons.css').read()
names = set(re.findall(r'fa-([a-z0-9-]+)', src)) | set(re.findall(r'\.fa-([a-z0-9-]+)::before', old))
names -= {'spin', 'solid', 'regular', 'brands', 'fw', 'lg', 'xs', 'sm', '2x', '3x'}
css = open(FA + '/css/fontawesome.css', encoding='utf8').read()
code = {n: int(m.group(1), 16) for n in names for m in [re.search(r'\.fa-%s\s*\{\s*--fa:\s*"\\([0-9a-fA-F]+)"' % re.escape(n), css)] if m}
missing = sorted(names - set(code))
# regular (outline) variants are used only where "far" appears on the same line as the icon
reg_names = set()
for line in src.split('\n'):
    if 'far' in line: reg_names |= set(re.findall(r'fa-([a-z0-9-]+)', line))
solid_font = TTFont(FA + '/webfonts/fa-solid-900.ttf'); reg_font = TTFont(FA + '/webfonts/fa-regular-400.ttf')
solid_cmap = solid_font.getBestCmap(); reg_cmap = reg_font.getBestCmap()
reg = {n for n in reg_names if n in code and code[n] in reg_cmap}
def subset(ttf, cps, out):
    subprocess.check_call(['pyftsubset', ttf, '--unicodes=' + ','.join('U+%04X' % c for c in sorted(cps)), '--flavor=woff', '--output-file=' + out, '--layout-features=', '--no-hinting'])
subset(FA + '/webfonts/fa-solid-900.ttf', {c for n, c in code.items() if c in solid_cmap}, ROOT + '/assets/fonts/fa-solid.woff')
subset(FA + '/webfonts/fa-regular-400.ttf', {code[n] for n in reg}, ROOT + '/assets/fonts/fa-regular.woff')
# Fonts are cached for a year, so the URL carries a content hash: a changed icon set can never be served from a stale cached font
def h(f): return hashlib.md5(open(ROOT + '/assets/fonts/' + f, 'rb').read()).hexdigest()[:8]
hs, hr = h('fa-solid.woff'), h('fa-regular.woff')
head = '\n'.join(old.split('\n')[:8])
head = re.sub(r'fa-solid\.woff[^)]*\)', 'fa-solid.woff?h=%s)' % hs, head)
head = re.sub(r'fa-regular\.woff[^)]*\)', 'fa-regular.woff?h=%s)' % hr, head)
for page in ('index.html',):
    t = open(ROOT + '/' + page, encoding='utf8').read()
    t = re.sub(r'/assets/fonts/fa-solid\.woff(\?h=\w+)?', '/assets/fonts/fa-solid.woff?h=%s' % hs, t)
    open(ROOT + '/' + page, 'w', encoding='utf8').write(t)
for page in ('indexadmin.html',):
    t = open(ROOT + '/' + page, encoding='utf8').read()
    t = re.sub(r'/assets/fonts/fa-solid\.woff(\?h=\w+)?', '/assets/fonts/fa-solid.woff?h=%s' % hs, t)
    open(ROOT + '/' + page, 'w', encoding='utf8').write(t)
rules = '\n'.join('.fa-%s::before{content:"\\%s"}' % (n, '%x' % code[n]) for n in sorted(code))
open(ROOT + '/assets/css/icons.css', 'w').write(head + '\n' + rules + '\n')
print('icons:', len(code), '| regular:', len(reg), '| missing from FA:', missing)
