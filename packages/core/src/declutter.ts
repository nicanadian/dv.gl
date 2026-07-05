/*
 * Copyright 2026 nicanadian
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Greedy screen-space label declutter: given axis-aligned label boxes with
 * priorities, decide which to show so no two visible boxes overlap. Higher
 * priority wins; ties keep input order (stable). Pure geometry -- the host owns
 * what a label SAYS and how it looks; dv.gl decides which ones fit.
 */

export interface LabelBox {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** Higher shows first and wins overlaps. */
  readonly priority: number;
}

function overlaps(a: LabelBox, b: LabelBox): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/**
 * Returns a visibility flag per input box (same order). Boxes are considered in
 * descending priority; each is shown unless it overlaps an already-shown box.
 */
export function declutterLabels(boxes: readonly LabelBox[]): boolean[] {
  const order = boxes
    .map((_, i) => i)
    .sort((a, b) => {
      const pa = boxes[a]?.priority ?? 0;
      const pb = boxes[b]?.priority ?? 0;
      return pb - pa || a - b; // priority desc, stable by index
    });
  const visible = new Array<boolean>(boxes.length).fill(false);
  const shown: LabelBox[] = [];
  for (const i of order) {
    const box = boxes[i];
    if (box === undefined) continue;
    if (shown.some((s) => overlaps(box, s))) continue;
    visible[i] = true;
    shown.push(box);
  }
  return visible;
}
