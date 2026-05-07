# Production Checklist for Private React Projects

Use this final checklist before shipping `my-page-agent` in a private React application.

## Packaging & Releases

- [ ] Publish through your private distribution path only (private registry, GitHub Packages, workspace, or private Git dependency).
- [ ] Version releases with semver and tag each release in Git.
- [ ] Keep the public API stable and avoid exposing internal-only entry points.
- [ ] Ship generated types and the production bundle you expect consumers to install.
- [ ] Record release notes for each production version.

## Build Quality

- [ ] `npm run lint` passes.
- [ ] `npm run test` passes.
- [ ] `npm run build` passes and produces the expected output.
- [ ] Production build settings are reproducible across local, CI, and release environments.
- [ ] Bundle size is reviewed before release.

## Security

- [ ] **Do not expose provider API keys in browser code.**
- [ ] **Do not embed raw OpenAI or other provider secrets in React environment variables shipped to the client.**
- [ ] **Route model requests through a backend proxy or token service you control.**
- [ ] Protect the backend proxy with authentication, authorization, and rate limiting.
- [ ] Validate and constrain agent task input on the server where applicable.
- [ ] Review CSP, allowed origins, and any network egress rules in the host app.
- [ ] Monitor for abuse, unexpected automation behavior, and excessive token usage.

## Runtime Safety in Browser

- [ ] Run the agent only in the browser, never during SSR.
- [ ] Guard initialization when `window` or `document` is unavailable.
- [ ] Set conservative `maxSteps`, timeouts, and retry behavior.
- [ ] Prevent unsafe actions on pages with destructive side effects unless explicitly intended.
- [ ] Handle DOM changes gracefully when indexed elements move or disappear mid-run.
- [ ] Provide a clear stop/cancel path for users.

## React Integration Standards

- [ ] Initialize the agent once per intended scope by using `useMemo`, `useRef`, or a dedicated hook.
- [ ] Clean up panel, listeners, or other resources on component unmount.
- [ ] Keep run state, results, and errors in controlled React state.
- [ ] Block overlapping executions unless concurrency is intentionally supported.
- [ ] Hide the feature behind a rollout flag until production confidence is established.

## Observability

- [ ] Log task lifecycle events with task IDs, actions, durations, and outcomes.
- [ ] Send runtime exceptions to your error tracking system.
- [ ] Track success rate, failure categories, step counts, and execution latency.
- [ ] Make production debugging possible without logging secrets or sensitive page content.

## Testing

- [ ] Keep unit coverage for prompt building, action parsing, and client behavior.
- [ ] Run integration tests against representative pages or forms used by your React app.
- [ ] Mock model responses in CI to keep tests deterministic.
- [ ] Re-test common user flows after changing prompts, tools, or DOM interaction logic.

## Compatibility

- [ ] Define the browsers you support in production.
- [ ] Verify behavior in every browser your React project officially supports.
- [ ] Document limitations for iframes, shadow DOM, auth walls, or highly dynamic pages.
- [ ] Review accessibility impact for focus handling, keyboard usage, and user feedback.

## Documentation

- [ ] Document the approved React integration pattern for your team.
- [ ] Document the backend proxy architecture and secret-handling rules.
- [ ] Keep setup, configuration, and troubleshooting steps current.
- [ ] Include known limitations and safe-use guidance for production teams.

## Operations & Governance

- [ ] Assign an owning team or maintainer for releases and incidents.
- [ ] Define a process for dependency updates and security patches.
- [ ] Review third-party licenses and internal usage approvals.
- [ ] Define rollback, deprecation, and support expectations before rollout.
