---
description: Scout gathers context, planner produces a plan — no implementation
---
Use the subagent tool with the chain parameter to execute this workflow:

1. Use the "scout" agent to find all code relevant to: $@
2. Use the "planner" agent to create an implementation plan for "$@" from the previous step's context (pass it with the {previous} placeholder)

Execute this as a single chain call, passing output between steps via {previous}. Do not implement anything — return the plan.
