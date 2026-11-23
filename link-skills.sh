#!/bin/sh
# Link every skill in this repo into a project's .claude/skills directory so
# Claude Code finds them (it expects .claude/skills/<name>/SKILL.md, flat) while
# the files stay grouped by stack here. Run from anywhere inside the project:
#   .agents/skills/link-skills.sh            # links into <project>/.claude/skills
#   .agents/skills/link-skills.sh <dir>      # links into another directory
# Idempotent: refreshes links, removes links to skills that no longer exist,
# never touches real (non-symlink) skill folders.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
project=$(git -C "$here" rev-parse --show-superproject-working-tree)
[ -n "$project" ] || project=$(cd "$here/../.." && pwd)
target="${1:-$project/.claude/skills}"
mkdir -p "$target"
target=$(cd "$target" && pwd)

# Relative link prefix from target back to this repo, so links work on any machine.
rel=$(python3 -c 'import os,sys; print(os.path.relpath(sys.argv[1], sys.argv[2]))' "$here" "$target")

# Drop stale links that point into this repo.
for link in "$target"/*; do
  [ -L "$link" ] || continue
  case "$(readlink "$link")" in
    "$rel"/*) [ -e "$link" ] || { rm "$link"; echo "removed stale $(basename "$link")"; } ;;
  esac
done

for skill_md in "$here"/*/*/SKILL.md; do
  dir=$(dirname "$skill_md")
  name=$(basename "$dir")
  stack=$(basename "$(dirname "$dir")")
  dest="$target/$name"
  if [ -e "$dest" ] && [ ! -L "$dest" ]; then
    echo "skip $name: $dest exists and is not a symlink" >&2
    continue
  fi
  ln -sfn "$rel/$stack/$name" "$dest"
  echo "linked $name -> $rel/$stack/$name"
done
