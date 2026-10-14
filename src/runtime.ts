/**
 * runtime — bridge for running Effect programs from non-Effect
 * Cloudflare/Pi callbacks.
 */

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntimeModule from "effect/ManagedRuntime";

export type ManagedRuntime<R, ER = never> = ManagedRuntimeModule.ManagedRuntime<R, ER>;

export const isManagedRuntime = ManagedRuntimeModule.isManagedRuntime;

export function makeManagedRuntime<R, ER>(
  layer: Layer.Layer<R, ER, never>,
  options?: {
    readonly memoMap?: Layer.MemoMap | undefined;
  } | undefined,
): ManagedRuntime<R, ER> {
  return ManagedRuntimeModule.make(layer, options);
}

export function runPromise<R, ER, A, E>(
  runtimeOrLayer: ManagedRuntime<R, ER> | Layer.Layer<R, ER, never>,
  effect: Effect.Effect<A, E, R>,
  options?: { readonly signal?: AbortSignal | undefined },
): Promise<A> {
  // SAFETY: isManagedRuntime narrows the union before this point.
  const runtime = isManagedRuntime(runtimeOrLayer)
    ? runtimeOrLayer
    : makeManagedRuntime(
        // SAFETY: isManagedRuntime was false, so the value is a layer with matching R/ER.
        runtimeOrLayer as Layer.Layer<R, ER, never>,
      );

  return runtime.runPromise(effect, options);
}

export function makeRunner<R, ER>(
  runtimeOrLayer: ManagedRuntime<R, ER> | Layer.Layer<R, ER, never>,
) {
  const runtime = isManagedRuntime(runtimeOrLayer)
    ? runtimeOrLayer
    : makeManagedRuntime(
        // SAFETY: isManagedRuntime was false, so the value is a layer with matching R/ER.
        runtimeOrLayer as Layer.Layer<R, ER, never>,
      );

  return <A, E>(
    effect: Effect.Effect<A, E, R>,
    options?: { readonly signal?: AbortSignal | undefined },
  ) => runtime.runPromise(effect, options);
}