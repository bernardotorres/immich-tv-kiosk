#!/usr/bin/env bash
# Fill the flat Nature Sounds folder on peri with long recordings. Idempotent; run detached:
#   nohup photo-proxy/scripts/fetch-nature.sh >/dev/null 2>&1 &
# Log and credits: $NATURE_DIR/fetch.log, $NATURE_DIR/credits.tsv.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NATURE_DIR="${NATURE_DIR:-/home/bernardo/Library/musik/nature}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) NATURE_DIR="$2"; shift 2 ;;
    *) echo "usage: $0 [--dir DIR]" >&2; exit 2 ;;
  esac
done

UA="peri-photoskiosk-fetch/1.0"
IA_ITEMS="australian-forest-sounds relaxingrainsounds ocean-sea-sounds naturesounds-soundtheraphy"

mkdir -p "$NATURE_DIR"
LOG="$NATURE_DIR/fetch.log"
CREDITS="$NATURE_DIR/credits.tsv"
exec >> "$LOG" 2>&1

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }

[[ -f "$CREDITS" ]] || printf 'id\tregion\trec\tlic\tloc\tlength\n' > "$CREDITS"

# fetch URL DEST: no-op when DEST exists and is non-empty; sets DOWNLOADED=1 on a new download.
DOWNLOADED=0
fetch() {
  DOWNLOADED=0
  [[ -s "$2" ]] && return 0
  curl -fsSL --retry 3 --retry-delay 5 -H "User-Agent: $UA" -o "$2.part" "$1" || { rm -f "$2.part"; return 1; }
  magic="$(head -c 3 "$2.part" | od -An -tx1 | tr -d ' \n')"
  if [[ "$magic" != 494433 && "$magic" != ff* ]]; then
    log "SKIP not-mp3 $(basename "$2")"; rm -f "$2.part"; return 1
  fi
  mv "$2.part" "$2"
  DOWNLOADED=1
  log "GET $(basename "$2")"
}

# credit ID REGION REC LIC LOC LENGTH: append once per id.
credit() {
  if awk -F'\t' -v id="$1" '$1 == id { found = 1 } END { exit !found }' "$CREDITS"; then return 0; fi
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" "$5" "$6" >> "$CREDITS"
}

# Part A: Internet Archive. Output per file: name, licence, clean base name, URL-quoted name.
IA_PY='
import json, os, re, sys, urllib.parse
d = json.load(sys.stdin)
lic = (d.get("metadata") or {}).get("licenseurl") or "-"
for f in d.get("files") or []:
    n = f.get("name") or ""
    if not n.lower().endswith(".mp3") or f.get("source") != "original":
        continue
    raw = os.path.basename(n)[:-4]
    base = re.sub(r"^\s*\d+\s*[-_. ]*\s*", "", raw).replace("_", " ")
    base = re.sub(r"[/\\]", "-", re.sub(r"\s+", " ", base).strip()) or raw
    print("\t".join([n, lic, base, urllib.parse.quote(n, safe="")]))
'

ia_list() {
  curl -fsSL --retry 3 --retry-delay 5 -H "User-Agent: $UA" "https://archive.org/metadata/$1" | python3 -I -c "$IA_PY"
}

log "START fetch-nature dir=$NATURE_DIR"

for item in $IA_ITEMS; do
  if [[ "$item" == australian-forest-sounds ]]; then region=Australia; else region=Nature; fi
  if ! meta_rows="$(ia_list "$item")"; then
    log "FAIL metadata $item"
    continue
  fi
  while IFS=$'\t' read -r name lic base quoted; do
    [[ -n "$name" ]] || continue
    dest="$NATURE_DIR/${region} · ${base}.mp3"
    if fetch "https://archive.org/download/$item/$quoted" "$dest"; then
      credit "ia:$item/$name" "$region" "Internet Archive" "$lic" "$base" "-"
    else
      log "FAIL internet-archive $item/$name"
    fi
  done <<< "$meta_rows"
done

# Part B: xeno-canto API v3. Key from the environment, else from photo-proxy/.env (read in a subshell).
XENO_CANTO_KEY="${XENO_CANTO_KEY:-}"
if [[ -z "$XENO_CANTO_KEY" && -f "$SCRIPT_DIR/../.env" ]]; then
  XENO_CANTO_KEY="$(set -a; . "$SCRIPT_DIR/../.env" >/dev/null 2>&1; printf '%s' "${XENO_CANTO_KEY:-}")"
fi

# Output per recording: id, download URL with key, target file name, region, rec, lic, loc, length.
# Ids are de-duplicated within this run only; reruns hit the same deterministic file names and skip.
XC_PY='
import json, os, re, sys, time, urllib.parse, urllib.request
sys.stdout.reconfigure(encoding="utf-8")
key = os.environ["XC_KEY"]
UA = "peri-photoskiosk-fetch/1.0"
SETS = [
    ("Brasil Amazônia", "grp:soundscape box:-10,-74,2,-48 len:\">120\"", 40),
    ("Brasil Pantanal e Cerrado", "grp:soundscape box:-22,-60,-14,-47 len:\">600\"", 40),
    ("Brasil Mata Atlântica", "grp:soundscape box:-30,-52,-8,-34 len:\">600\"", 60),
    ("Deutschland", "grp:soundscape cnt:germany len:\">1200\"", 40),
    ("Polska", "grp:soundscape cnt:poland len:\">300\"", 60),
]

def clean(s):
    return re.sub(r"\s+", " ", str(s or "")).strip()

def secs(length):
    try:
        t = 0
        for p in str(length).split(":"):
            t = t * 60 + int(p)
        return t
    except ValueError:
        return 0

def get(q, page):
    url = ("https://xeno-canto.org/api/3/recordings?query=" + urllib.parse.quote(q, safe="")
           + "&key=" + urllib.parse.quote(key, safe="") + "&page=" + str(page))
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)

seen = set()
for label, q, cap in SETS:
    try:
        first = get(q, 1)
        recs = list(first.get("recordings") or [])
        for p in range(2, int(first.get("numPages") or 1) + 1):
            time.sleep(1)
            recs.extend(get(q, p).get("recordings") or [])
    except Exception as e:
        print("xeno-canto " + label + ": " + type(e).__name__, file=sys.stderr)
        continue
    recs.sort(key=lambda r: secs(r.get("length")), reverse=True)
    n = 0
    for r in recs:
        if n >= cap:
            break
        xid = str(r.get("id") or "")
        f = r.get("file")
        if not xid or not f or xid in seen:
            continue
        seen.add(xid)
        n += 1
        loc = re.sub(r"[/\\]", "-", clean(r.get("loc")))[:80].strip() or "-"
        target = label + " · " + loc + " (XC" + xid + ").mp3"
        durl = f + ("&" if "?" in f else "?") + "key=" + urllib.parse.quote(key, safe="")
        print("\t".join([xid, durl, target, label, clean(r.get("rec")) or "-",
                         clean(r.get("lic")) or "-", loc, clean(r.get("length")) or "-"]))
'

xc_listing() {
  XC_KEY="$1" python3 -I -c "$XC_PY"
}

if [[ -z "$XENO_CANTO_KEY" ]]; then
  log "XENO_CANTO_KEY not set, skipping xeno-canto"
else
  if ! xc_rows="$(xc_listing "$XENO_CANTO_KEY")"; then
    log "FAIL xeno-canto listing"
    xc_rows=""
  fi
  while IFS=$'\t' read -r xid url target region rec lic loc length; do
    [[ -n "$xid" ]] || continue
    dest="$NATURE_DIR/$target"
    if fetch "$url" "$dest"; then
      credit "xc:$xid" "$region" "$rec" "$lic" "$loc" "$length"
      if [[ "$DOWNLOADED" -eq 1 ]]; then sleep 2; fi
    else
      log "FAIL xeno-canto XC$xid"
    fi
  done <<< "$xc_rows"
fi

count="$(find "$NATURE_DIR" -maxdepth 1 -type f -name '*.mp3' | wc -l | tr -d ' ')"
size="$(du -sh "$NATURE_DIR" | cut -f1)"
log "END files=$count (mp3) size=$size"
