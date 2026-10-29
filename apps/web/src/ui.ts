/**
 * ui — the app's one door to `@foldkit/ui`.
 *
 * Every component behind it is headless: it hands back attribute bundles and
 * the app supplies the markup and the classes `styles.css` already targets.
 * That keeps the design where it is and moves the accessibility work — the
 * `id`/`for` pair, the description reference, the disabled and invalid states,
 * progress semantics — out of each call site and into one place.
 *
 * The wrappers exist because `@foldkit/ui` pins `Message` through the builder
 * it is given, and because a call site should read as markup rather than as a
 * `toView` closure. Everything takes the builder last, the way the app's own
 * views do.
 */
import * as Button from "@foldkit/ui/button";
import * as Input from "@foldkit/ui/input";
import * as Select from "@foldkit/ui/select";
import * as Textarea from "@foldkit/ui/textarea";
import type { Attribute, Html, HtmlBuilder } from "foldkit/html";

/** A button's children: markup or bare text, as the builder itself takes. */
type Child = Html | string;

import type { Message } from "./message.ts";

/** What every labelled control on the roster and the composer is given. */
export interface FieldConfig {
  /** The DOM id the label points at. Unique among the screen's controls. */
  readonly id: string;
  readonly label: string;
  /** The `data-field` hook the CSS and the tests read. */
  readonly hook: string;
  readonly isInvalid?: boolean;
}

export interface ButtonConfig {
  readonly className: string;
  readonly onClick?: Message;
  readonly type?: "button" | "submit" | "reset";
  readonly isDisabled?: boolean;
  readonly ariaLabel?: string;
  /** Extra `data-*` hooks, as `[name, value]` pairs. */
  readonly data?: ReadonlyArray<readonly [string, string]>;
}

/**
 * A button. The component owns the click handler, the disabled state and the
 * `type` that keeps a trigger inside a form from submitting it; the app keeps
 * the class, the label and the data hooks its CSS and tests look for.
 *
 * `h.Disabled` is set alongside the component's `aria-disabled`, because a
 * submit button has to be natively disabled for the browser to stop the
 * submit, not merely announced as disabled to a screen reader.
 */
export const button = (
  config: ButtonConfig,
  children: readonly Child[],
  h: HtmlBuilder<Message>,
): Html => {
  const isDisabled = config.isDisabled ?? false;

  return Button.view(
    {
      type: config.type ?? "button",
      isDisabled,
      ...(config.onClick === undefined ? {} : { onClick: config.onClick }),
      toView: ({ button: attributes }) =>
        h.button(
          [
            ...attributes,
            h.Class(config.className),
            ...(isDisabled ? [h.Disabled(true)] : []),
            ...(config.ariaLabel === undefined ? [] : [h.AriaLabel(config.ariaLabel)]),
            ...(config.data ?? []).map(([name, value]) => h.DataAttribute(name, value)),
          ],
          children,
        ),
    },
    h,
  );
};

/** The label and an optional hint, wrapped the way `.field` styles them. */
const labelled = (
  config: FieldConfig,
  attributes: {
    readonly label: ReadonlyArray<Attribute<Message>>;
    readonly control: Html;
    readonly hint?: Html;
  },
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class("field")],
    [
      h.label([h.Class("field-label"), ...attributes.label], [config.label]),
      attributes.control,
      ...(attributes.hint === undefined ? [] : [attributes.hint]),
    ],
  );

/** A single-line text field. */
export const textField = (
  config: FieldConfig & {
    readonly value: string;
    readonly onInput: (value: string) => Message;
    readonly placeholder?: string;
    readonly hint?: string;
  },
  h: HtmlBuilder<Message>,
): Html =>
  Input.view(
    {
      id: config.id,
      value: config.value,
      isInvalid: config.isInvalid ?? false,
      hasDescription: config.hint !== undefined,
      onInput: config.onInput,
      ...(config.placeholder === undefined ? {} : { placeholder: config.placeholder }),
      toView: ({ input, label, description }) =>
        labelled(
          config,
          {
            label,
            control: h.input([...input, h.Class("input"), h.DataAttribute("field", config.hook)]),
            ...(config.hint === undefined
              ? {}
              : {
                  hint: h.span([...description, h.Class("field-hint")], [config.hint]),
                }),
          },
          h,
        ),
    },
    h,
  );

/** A multi-line text field: the prompts, the briefs and the composer. */
export const textareaField = (
  config: FieldConfig & {
    readonly value: string;
    readonly onInput: (value: string) => Message;
    readonly placeholder?: string;
    readonly rows?: number;
    readonly className?: string;
  },
  h: HtmlBuilder<Message>,
): Html =>
  Textarea.view(
    {
      id: config.id,
      value: config.value,
      isInvalid: config.isInvalid ?? false,
      onInput: config.onInput,
      ...(config.placeholder === undefined ? {} : { placeholder: config.placeholder }),
      ...(config.rows === undefined ? {} : { rows: config.rows }),
      toView: ({ textarea, label }) =>
        labelled(
          config,
          {
            label,
            control: h.textarea([
              ...textarea,
              h.Class(config.className ?? "input"),
              h.DataAttribute("field", config.hook),
            ]),
          },
          h,
        ),
    },
    h,
  );

/** One choice a `<select>` offers. */
export interface Choice {
  readonly value: string;
  readonly label: string;
}

/** A select over `choices`, with the current value already selected. */
export const selectField = (
  config: FieldConfig & {
    readonly value: string;
    readonly choices: readonly Choice[];
    readonly onChange: (value: string) => Message;
  },
  h: HtmlBuilder<Message>,
): Html =>
  Select.view(
    {
      id: config.id,
      value: config.value,
      isInvalid: config.isInvalid ?? false,
      onChange: config.onChange,
      toView: ({ select, label }) =>
        labelled(
          config,
          {
            label,
            control: h.select(
              [...select, h.Class("input"), h.DataAttribute("field", config.hook)],
              config.choices.map((choice) =>
                h.option(
                  [h.Value(choice.value), h.Selected(choice.value === config.value)],
                  [choice.label],
                ),
              ),
            ),
          },
          h,
        ),
    },
    h,
  );
