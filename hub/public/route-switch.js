// Who answers workers' permission requests (decision 21), as a plain switch under the hub's name: it is one setting for
// every project, so it sits above the project picker, not beside the per-project Auto/Ask and connector switches.
// Off means every request interrupts you, so off carries a small amber mark.

export function routeSwitch({ on = true, rules = null } = {}) {
  const word = on ? 'Orchestrator answers' : 'All to you';
  const tip = on
    ? `For every project: routine permission requests go to the orchestrator first${rules ? `, under ${rules}` : ' (no rules on the board yet, so they still come to you)'}; risky ones always come to you. Click to have every request come to you.`
    : 'For every project: every permission request comes to you, so each one interrupts you. Click to let the orchestrator answer routine ones first; risky ones still come to you.';
  return { on, word, tip, warn: !on };
}
