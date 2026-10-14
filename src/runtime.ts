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
  runtime: ManagedRuntime<R, ER>,
  effect: Effect.Effect<A, E, R>,
  options?: { readonly signal?: AbortSignal | undefined },
): Promise<A>;
export function runPromise<R, ER, A, E>(
  layer: Layer.Layer<R, ER, never>,
  effect: Effect.Effect<A, E, R>,
  options?: { readonly signal?: AbortSignal | undefined },
): Promise<A>;
export function runPromise<R, ER>(
  runtimeOrLayer: ManagedRuntime<R, ER> | Layer.Layer<R, ER, never>,
): <A, E>(
  effect: Effect.Effect<A, E, R>,
  options?: { readonly signal?: AbortSignal | undefined },
) => Promise<A>;
export function runPromise(...args: readonly unknown[]): unknown {
  const [first, second, third] = args;

  const toRuntime = (value: unknown): ManagedRuntime<any, any> =>
    isManagedRuntime(value)
      ? (value as ManagedRuntime<any, any>)
      : makeManagedRuntime(value as Layer.Layer<any, any, never>);

  if (args.length === 1) {
    const runtime = toRuntime(first);
    return (effect: Effect.Effect<any, any, any>, options?: { readonly signal?: AbortSignal | undefined }) =>
      runtime.runPromise(effect, options);
  }

  const runtime = toRuntime(first);
  return runtime.runPromise(second as Effect.Effect<any, any, any>, third as { readonly signal?: AbortSignal | undefined } | undefined);
}
