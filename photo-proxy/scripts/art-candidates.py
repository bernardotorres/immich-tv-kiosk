#!/usr/bin/env python3
"""List hand-pick candidates for the art moods from lumen-gallery-webos's catalog (~7k CC0 / PD works, Cleveland
Museum of Art + Wikimedia Commons). Lumen's own collections are ignored; only its pre-filters are reused: the
people flag (strict: a work is people-free only with positive evidence) and the animal flag. Nothing is downloaded
but the catalog, cached beside this script. Output is TSV for a picks.tsv: hints, id, artist, title, date, w, h, url.

  scripts/art-candidates.py                     # people-free, >= 3000 px wide, aspect >= 1.4
  scripts/art-candidates.py --hint night        # only works whose title suggests that mood
  scripts/art-candidates.py --animals --aspect 1.25
"""
import argparse, json, os, re, subprocess, sys, urllib.parse

CATALOG = 'https://raw.githubusercontent.com/ammar027/lumen-gallery-webos/main/src/config/art.ts'
CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'lumen-art.ts')
CMA = 'https://openaccess-cdn.clevelandart.org/'
COMMONS = 'https://commons.wikimedia.org/wiki/Special:FilePath/'

# mood hints from title + artist; a work may carry several, or none
HINTS = {
    'calm': re.compile(r"\b(landscape|valley|mountains?|river|lake|forest|woods?|meadow|fields?|pasture|hills?|garden|pond|mist|fog|snow|winter|autumn|still life|flowers?|bouquet|blossoms?|lilies|roses?|tulips?|bamboo)\b", re.I),
    'colour': re.compile(r"impressionis|monet|pissarro|sisley|renoir|morisot|caillebotte|cezanne|cézanne|gauguin|van gogh|seurat|signac|abstract|composition|colou?r", re.I),
    'drama': re.compile(r"\b(storm|tempest|wreck|shipwreck|battle|deluge|flood|fire|burning|eruption|volcano|avalanche|thunder|lightning|rapids|cataract|siege|apocalypse|judgement|judgment|hell)\b", re.I),
    'night': re.compile(r"\b(night|nocturne|moon|moonlight|moonlit|evening|twilight|dusk|lantern|fireworks|stars?)\b", re.I),
    'pattern': re.compile(r"\b(ornament|calligraph\w*|tiles?|carpet|rug|textile|brocade|silk|geometric|arabesque|pattern|zellige|muqarnas|medallion|mosaic|kufic|folio)\b", re.I),
}

def load(refresh):
    if refresh or not os.path.exists(CACHE):
        subprocess.run(['curl', '-sfL', '--max-time', '120', CATALOG, '-o', CACHE], check=True)
    s = open(CACHE, encoding='utf-8').read()
    key = 'ARTWORKS: Artwork[] = '
    return json.loads(s[s.index(key) + len(key):].rstrip().rstrip(';'))

def url(r):
    return CMA + r['u'] if r['s'] == 'c' else COMMONS + urllib.parse.quote(r['u'])

ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
ap.add_argument('--min-width', type=int, default=3000, help='pixels; CMA print images top out at 3400 on the long side')
ap.add_argument('--aspect', type=float, default=1.4, help='minimum width/height; the TV is 1.78')
ap.add_argument('--max-aspect', type=float, default=2.4, help='drops handscrolls and friezes')
ap.add_argument('--people', action='store_true', help='keep works flagged as showing people')
ap.add_argument('--animals', action='store_true', help='only works flagged as showing animals')
ap.add_argument('--hint', choices=sorted(HINTS), help='only works whose title matches this mood')
ap.add_argument('--source', choices=['c', 'w'], help='c = Cleveland, w = Commons')
ap.add_argument('--refresh', action='store_true', help='re-download the catalog')
a = ap.parse_args()

rows = []
for r in load(a.refresh):
    if r['w'] < a.min_width or not a.aspect <= r['w'] / r['h'] <= a.max_aspect: continue
    if r['p'] and not a.people: continue
    if a.animals and not r['n']: continue
    if a.source and r['s'] != a.source: continue
    hints = [h for h, rx in HINTS.items() if rx.search(f"{r['t']} {r['a']}")]
    if a.hint and a.hint not in hints: continue
    rows.append((','.join(hints), r['id'], r['a'], r['t'], r['d'], r['w'], r['h'], url(r)))

rows.sort(key=lambda x: (x[0] == '', x[0], x[2], x[3]))
print('hints\tid\tartist\ttitle\tdate\tw\th\turl')
for row in rows: print('\t'.join(str(x) for x in row))
print(f'{len(rows)} candidates; hints: ' + ', '.join(f'{h} {sum(1 for x in rows if h in x[0].split(","))}' for h in HINTS), file=sys.stderr)
