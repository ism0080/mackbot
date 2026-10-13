import { defineRule } from "@oxlint/plugins";

const message = "Switch statements are banned. Use Match from effect.";

const rule = defineRule({
  meta: {
    type: "problem" as const,
    docs: {
      description: "Disallow switch statements. Use Match from effect instead.",
    },
  },
  create(context) {
    return {
      SwitchStatement(node) {
        context.report({
          node,
          message,
        });
      },
    };
  },
});

export default rule;
