---
description: Worker implements, reviewer reviews, worker applies the feedback
---
Use the subagent tool with the chain parameter to execute this workflow:

1. Use the "worker" agent to implement: $@
2. Use the "reviewer" agent to review the implementation from the previous step (pass it with the {previous} placeholder)
3. Use the "worker" agent to apply the review feedback from the previous step (pass it with the {previous} placeholder)

Execute this as a single chain call, passing output between steps via {previous}.
