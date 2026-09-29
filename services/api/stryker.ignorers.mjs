// Stryker ignorers, registered in stryker.config.mjs.
import { declareValuePlugin, PluginKind } from '@stryker-mutator/api/plugin';

/** Its first argument is the audit action (`orders.write`), asserted by tests: keep mutating it. */
const ACTION_ERRORS = new Set(['ForbiddenError']);

const isErrorName = (name) => typeof name === 'string' && name.endsWith('Error');

/** `new XxxError(<message>, …)`, except errors whose first argument is not a message. */
function isNewErrorMessage(call) {
  return (
    call.isNewExpression() &&
    call.node.callee.type === 'Identifier' &&
    isErrorName(call.node.callee.name) &&
    !ACTION_ERRORS.has(call.node.callee.name)
  );
}

/** `super(<message>, …)` inside `class XxxError`. */
function isErrorSuperMessage(call) {
  if (!call.isCallExpression() || call.node.callee.type !== 'Super') return false;
  const cls = call.findParent((p) => p.isClassDeclaration() || p.isClassExpression());
  return isErrorName(cls?.node.id?.name);
}

export const strykerPlugins = [
  // The human-readable text of an error is neither a rule nor the API contract: clients branch
  // on `code` and `details`, which stay mutated. Asserting exact messages would make tests brittle.
  declareValuePlugin(PluginKind.Ignore, 'error-message', {
    shouldIgnore(path) {
      const call = path.parentPath;
      if (!call || path.listKey !== 'arguments' || path.key !== 0) return undefined;
      if (isNewErrorMessage(call) || isErrorSuperMessage(call)) {
        return 'Error message text: not a rule, not the API contract (code/details are).';
      }
      return undefined;
    },
  }),
];
