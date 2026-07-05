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
 * Deterministic mission clock: the single source of scene time. The clock never
 * reads wall time itself -- the host calls `advance()` with a measured wall delta
 * -- so identical call sequences produce identical scene time on any machine
 * (required for reproducible playback and for the benchmark harness).
 *
 * Scene time is seconds since the mission epoch, confined to [0, windowSeconds].
 */

export type UnixMs = number;

export interface MissionClockOptions {
  /** Absolute epoch of scene time zero (Unix ms, UTC). */
  readonly epochMs: UnixMs;
  /** Length of the scrubbable window, seconds. Must be positive. */
  readonly windowSeconds: number;
  /** Scene seconds per wall second. Default 1. */
  readonly rate?: number;
  /** Wrap at the window end instead of clamping. Default true. */
  readonly loop?: boolean;
}

export class MissionClock {
  readonly epochMs: UnixMs;
  readonly windowSeconds: number;
  rate: number;
  loop: boolean;
  playing = false;
  private t = 0;

  constructor(options: MissionClockOptions) {
    if (!(options.windowSeconds > 0)) {
      throw new Error(`windowSeconds must be positive, got ${options.windowSeconds}`);
    }
    if (!Number.isFinite(options.epochMs)) {
      throw new Error("epochMs must be finite");
    }
    this.epochMs = options.epochMs;
    this.windowSeconds = options.windowSeconds;
    this.rate = options.rate ?? 1;
    this.loop = options.loop ?? true;
  }

  /** Current scene time, seconds since epoch, in [0, windowSeconds]. */
  get currentSeconds(): number {
    return this.t;
  }

  /** Current absolute time (Unix ms). */
  currentUnixMs(): UnixMs {
    return this.epochMs + this.t * 1000;
  }

  /**
   * Advance by a measured wall-clock delta (seconds). No-op unless playing.
   * Returns the new scene time.
   */
  advance(wallDeltaSeconds: number): number {
    if (!this.playing || wallDeltaSeconds <= 0) return this.t;
    return this.setTime(this.t + wallDeltaSeconds * this.rate);
  }

  /** Jump to an absolute scene time (scrub). Does not change play state. */
  scrubTo(seconds: number): number {
    return this.setTime(seconds);
  }

  play(): void {
    this.playing = true;
  }

  pause(): void {
    this.playing = false;
  }

  private setTime(seconds: number): number {
    if (Number.isNaN(seconds)) return this.t;
    if (this.loop) {
      const w = this.windowSeconds;
      this.t = ((seconds % w) + w) % w;
    } else {
      this.t = Math.min(this.windowSeconds, Math.max(0, seconds));
    }
    return this.t;
  }
}
