/**
 * json - JSON text through Schema, so the Worker has one encoder.
 *
 * Every caller hands over a value that is already JSON-shaped (a decoded row,
 * a view, a parsed MCP payload), so an encoding failure is a programming
 * error and surfaces as one rather than as a silent `undefined`.
 */

import * as Schema from "effect/Schema";

const encodeCompact = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const encodePretty = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown, { space: 2 }));

/** A value as compact JSON text. */
export const toJson = <A>(value: A): string => encodeCompact(value);

/** A value as JSON text indented by two spaces, for a reader rather than a parser. */
export const toPrettyJson = <A>(value: A): string => encodePretty(value);
