# Security policy

## Reporting a vulnerability

Please do **not** report a security problem in a public issue, pull request or
forum post.

Report it privately through GitHub instead: open the **Security** tab of this
repository, then **Report a vulnerability**.

No such button? Private reporting is not enabled yet: open an issue that only
asks the maintainers for a private contact, without any detail of the problem,
and send the report there.

Include, when you can:

- the version of the integration and of Gladys;
- what an attacker can do, and the steps to reproduce it;
- the log lines that help (remove tokens, passwords and addresses first).

The fix ships as a new version of the integration, and the advisory is
published once users can update.

## Supported versions

Only the latest release receives security fixes: update the integration from
Gladys before reporting a problem.

## Scope

In scope: the code of this repository and the Docker image it publishes.

What the integration holds:

- the Moonraker API keys, in the Gladys configuration (`secret` fields, never
  sent back to the browser by Gladys) — never in `/data`, never in the logs,
  and sent to nothing but the Moonraker they belong to (not to the webcam);
- `/data/moonraker-state.json`: what each configured printer has (heaters and
  their limits, sensors, fan, webcam address, macro names, host name), no
  secret;
- network: WebSocket connections to the Moonraker addresses the administrator
  entered, and HTTP(S) requests to the snapshot address of the printer's
  webcam, on the local network. No other outbound connection. Webcam
  redirects are not followed.

What the integration can make a printer do: pause, resume or cancel a print,
set heater targets within Klipper's own `max_temp` (never during a print),
turn the heaters off, restart Klipper after a shutdown, and run a G-code macro
the printer lists, by its name only (no parameter, no free G-code). It never
sends an emergency stop.

Out of scope: Gladys Assistant itself (see its
[security policy](https://github.com/GladysAssistant/Gladys/security/policy)),
Klipper and Moonraker themselves, and the macros the printer owner wrote.
