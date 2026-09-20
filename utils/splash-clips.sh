#!/usr/bin/env bash
#
# The splash clip pipeline: a folder of stock downloads in, a folder of matched
# 5-second clips out, for the sign-in page's shuffled, crossfaded backdrop.
#
#   utils/splash-clips.sh --scan       # 1. list new downloads into the run sheet
#   utils/splash-clips.sh              # 2. encode every row that needs it
#   (watch, correct the sheet)         # 3. fix start/length/speed, run again
#   utils/splash-clips.sh --sheets     #    a contact sheet per source, to pick a start
#   utils/splash-clips.sh --prune      #    remove outputs that no longer have a row
#   utils/splash-clips.sh --dry-run    #    say what would encode, encode nothing
#
# **THE SCRIPT FILLS IN THE FIGURES; THE HUMAN ONLY CORRECTS THEM.** Ziad's
# call, 2026-09-20. --scan probes each new file and writes a row with a guessed
# window (five seconds from the middle) and a guessed speed (from the frame
# rate alone: at or under 30 fps the footage is real time and gets the house
# half speed, at 50 and over it was shot for slow motion and is left at 1.0).
# The guess is wrong sometimes, which is what stage 3 is for.
#
# Layout — everything under _assets/ is gitignored and never published:
#   _assets/video/splash-clips/         the raw downloads, dropped in as-is
#   _assets/video/splash-clips.csv      the run sheet: written by --scan, edited by hand
#   _assets/video/splash-clips.last.csv the rows as last encoded (the script's own; not for editing)
#   _assets/video/splash-sheets/        contact sheets, from --sheets
#   public/video/splash/                the outputs — the folder the app lists at startup
#
# Sheet columns: file,fps,seconds,start,length,speed,out. fps and seconds are
# read from the file and are reference only; start, length and speed are the
# run figures; out is the output's name, routeloop-splash-clip-NN, numbered by
# --scan in the order files were first seen and never reused, so a clip keeps
# its name however the sheet is edited. A row starting with # is retired: not
# encoded, and --prune removes its output.
#
# **INTERPOLATION IS DECIDED PER CLIP.** After setpts the effective rate is
# fps × speed; below 25 the frames have to be invented (minterpolate), at or
# above there are real frames to spare and a plain fps=25 drops the extras —
# faster and sharper. The house look is the intro's recipe from docs/STATUS.md
# (8b39424): 1280×720, 25 fps, CRF 33, faststart, no audio.
#
# Re-running encodes only rows whose output is missing, whose source is newer
# than its output, or whose row differs from the snapshot. A row whose file is
# gone is reported and skipped, never deleted.
#
# macOS ships bash 3.2, so no associative arrays here; the snapshot is a file
# and lookups are greps. ffmpeg and ffprobe come from Homebrew.

set -euo pipefail

cd "$(dirname "$0")/.."

FFMPEG="${FFMPEG:-/opt/homebrew/bin/ffmpeg}"
FFPROBE="${FFPROBE:-/opt/homebrew/bin/ffprobe}"

SRC_DIR="_assets/video/splash-clips"
SHEET="_assets/video/splash-clips.csv"
LAST="_assets/video/splash-clips.last.csv"
SHEETS_DIR="_assets/video/splash-sheets"
OUT_DIR="public/video/splash"

# The house look.
WIDTH=1280
HEIGHT=720
FPS=25
CRF=33
PRESET=slow
DEFAULT_LENGTH=5
# The ceiling on a noisy clip. CRF alone let grainy 2016 footage run to
# 4.8 Mbps — 3 MB for five seconds, the whole old intro in one clip — while
# clean aerials sat near 1 Mbps. The cap holds the worst case to about twice
# the intro's rate and leaves a clean clip untouched.
MAXRATE=2M
BUFSIZE=4M

RED=$'\033[0;31m'; YEL=$'\033[0;33m'; GRN=$'\033[0;32m'; DIM=$'\033[2m'; OFF=$'\033[0m'
info() { printf '%s==>%s %s\n' "$DIM" "$OFF" "$*"; }
warn() { printf '%s !%s %s\n' "$YEL" "$OFF" "$*"; }
ok()   { printf '%s ✓%s %s\n' "$GRN" "$OFF" "$*"; }
die()  { printf '%sERROR%s %s\n' "$RED" "$OFF" "$*" >&2; exit 1; }

MODE=run
DRY=""
for arg in "$@"; do
  case "$arg" in
    --scan) MODE=scan ;;
    --sheets) MODE=sheets ;;
    --prune) MODE=prune ;;
    --dry-run) DRY=1 ;;
    -h|--help) sed -n '2,45p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown flag: $arg" ;;
  esac
done

[ -x "$FFMPEG" ] || die "ffmpeg not found at $FFMPEG (brew install ffmpeg)"
[ -x "$FFPROBE" ] || die "ffprobe not found at $FFPROBE"

mkdir -p "$SRC_DIR" "$OUT_DIR"
[ -f "$SHEET" ] || printf 'file,fps,seconds,start,length,speed,out\n' > "$SHEET"
[ -f "$LAST" ] || : > "$LAST"

# ——— Helpers ———

# Video by extension, case-insensitive; zips, jpegs and sidecars never match.
list_sources() {
  find "$SRC_DIR" -maxdepth 1 -type f \
    \( -iname '*.mp4' -o -iname '*.mov' -o -iname '*.m4v' -o -iname '*.webm' \
       -o -iname '*.mkv' -o -iname '*.avi' -o -iname '*.mts' -o -iname '*.m2ts' \) \
    | sed "s#^$SRC_DIR/##" | sort
}

# The next output number: one past the highest the sheet has handed out,
# retired rows included, so a number is never given twice.
next_number() {
  awk -F, 'NR > 1 && $7 ~ /-[0-9]+$/ { n = $7; sub(/.*-/, "", n); if (n + 0 > max) max = n + 0 } END { print max + 1 }' "$SHEET"
}

# "fps seconds", from the first video stream and the container.
probe() {
  local f="$SRC_DIR/$1"
  local rate dur
  rate=$("$FFPROBE" -v error -select_streams v:0 -show_entries stream=r_frame_rate -of csv=p=0 "$f" | head -n 1)
  dur=$("$FFPROBE" -v error -show_entries format=duration -of csv=p=0 "$f" | head -n 1)
  [ -n "$rate" ] && [ -n "$dur" ] || die "could not probe $1"
  # r_frame_rate is a ratio (30000/1001); awk does the division.
  awk -v r="$rate" -v d="$dur" 'BEGIN {
    split(r, p, "/"); fps = (p[2] + 0 > 0) ? p[1] / p[2] : p[1] + 0
    printf "%.3f %.3f", fps, d
  }'
}

# Does the sheet already carry this file? Rows are matched on the first field,
# retired rows included, so a clip retired with # is not re-added by --scan.
in_sheet() {
  awk -F, -v f="$1" 'NR > 1 { row = $1; sub(/^#/, "", row); if (row == f) found = 1 } END { exit found ? 0 : 1 }' "$SHEET"
}

# ——— --scan ———

scan() {
  local added=0
  while IFS= read -r file; do
    [ -n "$file" ] || continue
    if in_sheet "$file"; then continue; fi
    read -r fps seconds <<< "$(probe "$file")"
    local speed start
    # The guess: real-time footage gets the house half speed; 50 fps and over
    # was shot for slow motion and halving it again looks like syrup.
    speed=$(awk -v f="$fps" 'BEGIN { print (f >= 50) ? "1.0" : "0.5" }')
    # Centred, and never negative on a clip shorter than the window.
    start=$(awk -v s="$seconds" -v l="$DEFAULT_LENGTH" -v v="$speed" 'BEGIN { x = (s - l * v) / 2; if (x < 0) x = 0; printf "%.2f", x }')
    local out
    out=$(printf 'routeloop-splash-clip-%02d' "$(next_number)")
    printf '%s,%s,%s,%s,%s,%s,%s\n' "$file" "$fps" "$seconds" "$start" "$DEFAULT_LENGTH" "$speed" "$out" >> "$SHEET"
    ok "$file → $out  ${fps} fps, ${seconds}s → start $start, length $DEFAULT_LENGTH, speed $speed"
    added=$((added + 1))
  done <<< "$(list_sources)"
  info "$added new row(s) in $SHEET; rows already there were left alone"
}

# ——— run ———

# One row: encode if the output is missing, stale, or the row changed.
encode_row() {
  local row="$1"
  local file fps seconds start length speed name
  IFS=, read -r file fps seconds start length speed name <<< "$row"
  [ -n "$name" ] || { warn "$file: no out name in its row; run --scan on a fresh sheet"; return 0; }
  local src="$SRC_DIR/$file"
  local out="$OUT_DIR/$name.mp4"

  if [ ! -f "$src" ]; then
    warn "$file: source is gone; row kept, nothing encoded"
    return 0
  fi

  local reason=""
  if [ ! -f "$out" ]; then reason="no output yet"
  elif [ "$src" -nt "$out" ]; then reason="source is newer"
  elif ! grep -qxF -- "$row" "$LAST"; then reason="row changed"
  fi
  if [ -z "$reason" ]; then
    printf '%s  %s%s%s\n' "$DIM" "$file" ": up to date" "$OFF"
    return 0
  fi

  # The arithmetic the sheet never has to carry.
  local pts effective rate_filter
  pts=$(awk -v v="$speed" 'BEGIN { printf "%.6f", 1 / v }')
  effective=$(awk -v f="$fps" -v v="$speed" 'BEGIN { printf "%.3f", f * v }')
  if awk -v e="$effective" -v t="$FPS" 'BEGIN { exit (e < t) ? 0 : 1 }'; then
    rate_filter="minterpolate=fps=$FPS:mi_mode=mci:mc_mode=aobmc:vsbmc=1"
  else
    rate_filter="fps=$FPS"
  fi

  info "$file → $(basename "$out")  ($reason; start $start, ${length}s at ${speed}×, ${rate_filter%%=*})"
  if [ -n "$DRY" ]; then return 0; fi

  # -ss BEFORE -i: a fast seek that is frame-accurate on any ffmpeg of this
  # decade, and the only way a 2 GB download is cut in seconds. -t is an
  # OUTPUT option and so is the OUTPUT length — after setpts, not before: with
  # the source length there a half-speed clip came out half as long. Scale
  # then crop centres a portrait or 4:3 source rather than letterboxing it;
  # scale before interpolating. -nostdin, or ffmpeg eats the rest of the sheet
  # out of the read loop's stdin as interactive commands — every second row
  # vanished, silently.
  "$FFMPEG" -nostdin -hide_banner -loglevel error -stats -y -ss "$start" -i "$src" -t "$length" \
    -filter:v "scale=$WIDTH:$HEIGHT:force_original_aspect_ratio=increase:flags=lanczos,crop=$WIDTH:$HEIGHT,setpts=${pts}*PTS,${rate_filter},format=yuv420p" \
    -map 0:v:0 -an -dn -r "$FPS" -g "$FPS" -force_key_frames 0 \
    -c:v libx264 -crf "$CRF" -maxrate "$MAXRATE" -bufsize "$BUFSIZE" -preset "$PRESET" -movflags +faststart "$out"

  # The snapshot: this file's row replaced, everything else kept.
  local tmp
  tmp=$(mktemp)
  awk -F, -v f="$file" '$1 != f' "$LAST" > "$tmp" || true
  printf '%s\n' "$row" >> "$tmp"
  mv "$tmp" "$LAST"
  ok "$(basename "$out")  $(du -h "$out" | cut -f1)"
}

run() {
  local n=0
  while IFS= read -r row; do
    [ -n "$row" ] || continue
    case "$row" in \#*) continue ;; esac
    encode_row "$row"
    n=$((n + 1))
  done <<< "$(tail -n +2 "$SHEET")"
  [ "$n" -gt 0 ] || warn "the sheet has no rows; run --scan first"
  info "$(ls "$OUT_DIR"/*.mp4 2>/dev/null | wc -l | tr -d ' ') clip(s) in $OUT_DIR, $(du -sh "$OUT_DIR" | cut -f1) in all"
}

# ——— --prune ———

prune() {
  local removed=0
  local live
  live=$(awk -F, 'NR > 1 && $1 !~ /^#/ { print $7 }' "$SHEET")
  for out in "$OUT_DIR"/*.mp4; do
    [ -f "$out" ] || continue
    local keep=""
    while IFS= read -r name; do
      [ -n "$name" ] || continue
      if [ "$OUT_DIR/$name.mp4" = "$out" ]; then keep=1; break; fi
    done <<< "$live"
    if [ -z "$keep" ]; then
      if [ -n "$DRY" ]; then info "would remove $(basename "$out")"; else rm -f "$out"; ok "removed $(basename "$out")"; fi
      removed=$((removed + 1))
    fi
  done
  info "$removed output(s) without a row"
}

# ——— --sheets ———

# One frame a second, six to a row, so a cell's place IS its time: row r,
# column c is second 6r + c. Homebrew's ffmpeg is built without drawtext, so
# the grid is the timestamp. Named after the row's output, so the sheet for
# clip 07 is sheet 07; a source with no row yet needs --scan first.
sheets() {
  mkdir -p "$SHEETS_DIR"
  while IFS= read -r row; do
    [ -n "$row" ] || continue
    local file fps seconds start length speed name
    IFS=, read -r file fps seconds start length speed name <<< "$row"
    file="${file#\#}"
    [ -f "$SRC_DIR/$file" ] || { warn "$file: source is gone"; continue; }
    local rows
    rows=$(awk -v s="$seconds" 'BEGIN { r = int((s + 5) / 6); if (r < 1) r = 1; print r }')
    local out="$SHEETS_DIR/$name.jpg"
    info "$file → $(basename "$out")  (${seconds}s, $rows row(s) of 6, one cell per second)"
    [ -n "$DRY" ] && continue
    "$FFMPEG" -nostdin -hide_banner -loglevel error -y -i "$SRC_DIR/$file" \
      -vf "fps=1,scale=320:-2,tile=6x${rows}:padding=4:margin=4:color=black" -frames:v 1 -q:v 4 "$out"
  done <<< "$(tail -n +2 "$SHEET")"
  ok "sheets in $SHEETS_DIR"
}

case "$MODE" in
  scan) scan ;;
  sheets) sheets ;;
  prune) prune ;;
  run) run ;;
esac
