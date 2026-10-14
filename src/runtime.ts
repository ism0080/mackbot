/**
 * runtime — bridge for running Effect programs from non-Effect
 * Cloudflare/Pi callbacks.
 */

import * as Layer from "effect/Layer";
import * as ManagedRuntimeModule from "effect/ManagedRuntime";

export type ManagedRuntime<R, ER = never> = ManagedRuntimeModule.ManagedRuntime<R, ER>;

export function makeManagedRuntime<R, ER>(
  layer: Layer.Layer<R, ER, never>,
  options?:
    | {
        readonly memoMap?: Layer.MemoMap | undefined;
      }
    | undefined,
): ManagedRuntime<R, ER> {
  return ManagedRuntimeModule.make(layer, options);
}
