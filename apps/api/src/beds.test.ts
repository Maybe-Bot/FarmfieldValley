import test from "node:test";
import assert from "node:assert/strict";
import { resolveBedEdgeOffsets, simplifyNearlyStraightLine, straightLineFromGuide } from "./beds";

test("simplifyNearlyStraightLine collapses practical hand-drawn edges", () => {
  const points = [
    { x: 0, y: 0 },
    { x: 35, y: 2 },
    { x: 70, y: -1.5 },
    { x: 100, y: 0 }
  ];

  assert.deepEqual(simplifyNearlyStraightLine(points), [points[0], points[3]]);
});

test("simplifyNearlyStraightLine preserves strongly curved guides", () => {
  const points = [
    { x: 0, y: 0 },
    { x: 40, y: 25 },
    { x: 80, y: 0 }
  ];

  assert.deepEqual(simplifyNearlyStraightLine(points), points);
});

test("straightLineFromGuide keeps generated beds on a straight guide", () => {
  const points = [
    { x: 0, y: 0 },
    { x: 40, y: 25 },
    { x: 80, y: 0 }
  ];

  assert.deepEqual(straightLineFromGuide(points), [points[0], points[2]]);
});

test("resolveBedEdgeOffsets nudges first boundary bed for clipping only", () => {
  assert.deepEqual(
    resolveBedEdgeOffsets({
      edgeOffsetM: 0,
      layoutIndex: 0,
      bedWidthM: 1.2,
      pathSpacingM: 0.45,
      sideSign: 1
    }),
    { clipOffsetM: 0.048 }
  );
});

test("resolveBedEdgeOffsets leaves later and selected-bed offsets unchanged", () => {
  assert.deepEqual(
    resolveBedEdgeOffsets({
      edgeOffsetM: 0,
      layoutIndex: 2,
      bedWidthM: 1.2,
      pathSpacingM: 0.45,
      sideSign: -1
    }),
    { clipOffsetM: -3.3 }
  );

  assert.deepEqual(
    resolveBedEdgeOffsets({
      edgeOffsetM: 0.45,
      layoutIndex: 0,
      bedWidthM: 1.2,
      pathSpacingM: 0.45,
      sideSign: 1
    }),
    { clipOffsetM: 0.45 }
  );
});
