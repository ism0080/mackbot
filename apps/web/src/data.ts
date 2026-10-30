import { Option } from "effect";
import { AsyncData } from "foldkit";

/** The value an `AsyncData` holds, or `undefined` while it holds none. */
export const dataOf = <A, E>(data: AsyncData.AsyncData<A, E>): A | undefined =>
  Option.getOrUndefined(AsyncData.getData(data));

/** The error an `AsyncData` holds, or `undefined` while it holds none. */
export const errorOf = <A, E>(data: AsyncData.AsyncData<A, E>): E | undefined =>
  Option.getOrUndefined(AsyncData.getError(data));
