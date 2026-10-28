/**
 * toast — the one transient line the server has to say out loud.
 *
 * The Foldkit UI `Toast` submodel owns the parts a hand-rolled toast gets
 * wrong: a stack rather than one slot (a second answer no longer overwrites a
 * first), an auto-dismiss timer that pauses while a pointer rests on it, enter
 * and leave animations, and the live-region roles that make a screen reader
 * announce it. The payload is only the words; the variant is chosen at the
 * point the answer arrives.
 */
import { Toast as UiToast } from "@foldkit/ui";
import * as Schema from "effect/Schema";

/** What one toast carries. The component never reads it. */
export const ToastPayload = Schema.Struct({
  text: Schema.String,
});

/** The app's Toast submodel, bound to the payload above. */
export const Toast = UiToast.make(ToastPayload);

/**
 * The container's id. It is also the `h.submodel` slot it renders in, so the
 * screens share one container rather than each owning a stack of its own.
 */
export const TOAST_ID = "mackbot-toasts";
