# 2. Hand-written Canvas 2D renderer

Status: accepted

## Context

Libraries such as Konva, Fabric or tldraw would save time but hide the
rendering, hit-testing and transform work this project exists to show.

## Decision

Draw with the Canvas 2D API directly. A `Scene` keeps world transforms and
bounds, updated incrementally from change sets, and a quadtree serves hit tests
and marquee selection. Overlays (selection, cursors, guides) draw on a second
canvas, so moving a cursor never redraws the content.

## Consequences

- Full control over culling, level of detail and redraw scheduling.
- 10,000 shapes draw in 4.6 ms at the median; a WebGL backend stays possible
  behind the same scene interface if needed.
