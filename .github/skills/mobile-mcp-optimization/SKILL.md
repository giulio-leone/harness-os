---
name: mobile-mcp-optimization
description: Enforce the use of mcp_mobile_multi_action to reduce latency and improve reliability during Mobile MCP UI automation.
---

# Mobile MCP Optimization: Multi-Action

When automating mobile UI flows using the `mobile-mcp` tools, individual tool calls for actions like tapping, typing, scrolling, and waiting introduce significant network and cognitive processing latency between each step.

To optimize execution speed and drastically reduce latency, **you MUST use the `mcp_mobile_multi_action` tool** instead of making sequential calls to `mcp_mobile_snapshot_and_act` or other single-action tools whenever possible.

## When to Use `multi_action`

Group actions together when:
1.  **Entering data:** Tap on an input field, wait for the keyboard to appear, type text, and press Enter/Done.
2.  **Navigating menus:** Tap a menu button, wait for the menu to open, and tap a menu item.
3.  **Filling forms:** Sequence taps on multiple fields, typing, and the final submit button all in one go.
4.  **Scrolling and interacting:** Swipe to reveal an element, wait for the animation, and then tap it.
5.  **Dismissing alerts/modals:** Tap OK/Cancel on an alert, then proceed with the flow.

## How to use `multi_action`

Instead of multiple LLM round-trips:
1. LLM decides to tap "Search".
2. Wait for tool result...
3. LLM decides to type "hello world".
4. Wait for tool result...
5. LLM decides to press "ENTER".

Plan the entire macro sequence and execute it in one call:
```json
{
  "device": "<device_id>",
  "actions": [
    { "action": "tap_text", "text": "Search", "delayAfter": 1000 },
    { "action": "type", "text": "hello world", "delayAfter": 500 },
    { "action": "press", "button": "ENTER", "delayAfter": 1500 }
  ]
}
```

### Supported Actions within `multi_action`:
*   `tap` (requires `x`, `y`)
*   `tap_text` (requires `text` - *Preferred over coordinates when possible*)
*   `tap_id` (requires `id` - *Safest option if resource-ids are available*)
*   `swipe` (requires `direction`: `up`, `down`, `left`, `right`)
*   `type` (requires `text`)
*   `press` (requires `button`, e.g., `HOME`, `BACK`, `ENTER`, `VOLUME_UP`, `VOLUME_DOWN`)
*   `long_press` (requires `x`, `y`, `duration` in ms)
*   `double_tap` (requires `x`, `y`)
*   `drag` (requires `startX`, `startY`, `endX`, `endY`, `duration` in ms)
*   `wait` (requires `ms` - Explicit pause)
*   `wait_for_text` (requires `text`, optional `timeout` in ms, default 5000)
*   `wait_for_id` (requires `id`, optional `timeout` in ms, default 5000)

## Best Practices for `multi_action`

1.  **Always use `delayAfter` for UI transitions:** When an action causes an animation (like opening a keyboard, navigating a screen, or expanding a dropdown), the next action might fail if executed instantly. Add `"delayAfter": 500` (or `1000` for slower transitions) to the action that triggers the animation.
2.  **Use `wait_for_text` / `wait_for_id` for network loads:** If navigating to a new screen requires a network request, use a `wait_for_*` action to ensure the screen is fully loaded before continuing the sequence. This is more robust than a fixed `delayAfter`.
3.  **Chain related tasks:** If you know you need to fill 3 text fields, do them all in one `multi_action`. Don't snapshot the screen between every single field if you already know their layout.
4.  **Use `skipSnapshot: true` for blind sequences:** If the sequence is just pressing HOME or navigating back multiple times and you don't immediately need the resulting UI tree, set `skipSnapshot: true` on the `mcp_mobile_multi_action` call to save bandwidth and time.
