# DSH with OpenRouter on Windows

How to give DSH an OpenRouter API key on Windows without pasting the key into DSH
or into a configuration file. The key lives in a Windows environment variable;
DSH reads it from the environment it was launched in.

Every command below is PowerShell.

## Get a key

Create a key at <https://openrouter.ai/keys>. It looks like:

```
sk-or-v1-xxxxxxxxxxxxxxxx
```

Treat it like a password. It is not redacted when echoed, so avoid printing it.

## Set the key for one session

In the PowerShell window you will launch DSH from:

```powershell
$env:OPENROUTER_API_KEY = "sk-or-v1-YOUR_ACTUAL_KEY"
```

Confirm it is set without displaying it:

```powershell
if ($env:OPENROUTER_API_KEY) { "OPENROUTER_API_KEY is set" } else { "OPENROUTER_API_KEY is NOT set" }
```

This variable exists only in that window. It is gone when the window closes, and
it does not reach a DSH started from anywhere else — the Start menu, a shortcut,
another terminal, or a window opened before the variable was set.

## Set the key permanently

The recommended setup on Windows. Store it once as a user environment variable:

```powershell
[Environment]::SetEnvironmentVariable("OPENROUTER_API_KEY", "sk-or-v1-YOUR_ACTUAL_KEY", "User")
```

This writes to the registry for your Windows user, so it is readable by anything
running as you. It does **not** affect the current window: `$env:OPENROUTER_API_KEY`
there is unchanged until you open a new one.

Close PowerShell completely, open a new window, and verify:

```powershell
if ($env:OPENROUTER_API_KEY) { "OpenRouter key loaded" } else { "OpenRouter key NOT loaded" }
```

To remove it later, set it to `$null`:

```powershell
[Environment]::SetEnvironmentVariable("OPENROUTER_API_KEY", $null, "User")
```

## Start DSH

From that same PowerShell window:

```powershell
dsh
```

If you normally start DSH with a different command, use that one — the point is
only that it inherits this window's environment.

Then, in DSH:

1. Open **Settings → Models → DeepSeek → Edit**. The API-key field should read
   something like *Provided by the launch environment (read-only)*. Do not paste
   the key there; a key entered in that field defeats the point of this setup.
2. Select the OpenRouter model:

   ```
   deepseek/deepseek-v4.1-flash
   ```

3. Start a new DSH session. A session already open was created under the old
   configuration and will not pick up the change.

## If DSH still shows the key error

Check the variable in the window DSH was launched from:

```powershell
$env:OPENROUTER_API_KEY
```

**Nothing printed** — the variable is not reaching DSH. Either it was set in a
different window, or it was set permanently and this window predates that, or DSH
was launched from a shortcut rather than from this window. Open a new PowerShell
window and start DSH from it.

**The key printed** — the variable is fine, so the provider configuration is what
is wrong. Open **Settings → Models → DeepSeek → Edit → Open configuration file**
and check that the OpenRouter provider reads the key from the environment:

```yaml
apiKeyEnv: OPENROUTER_API_KEY
```

The key itself should not appear in that file. If a literal key is in there,
replace it with `apiKeyEnv` — and rotate it at <https://openrouter.ai/keys>,
because a key written to a config file has usually been copied around or
committed somewhere by then.
