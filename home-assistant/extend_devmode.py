import json, os, subprocess, time, urllib.request

TV_HOST = "192.168.178.41"
SSH_PORT = 9922
KEY = "/config/lg/webos_rsa"
TOKEN_CACHE = "/config/lg/devmode_token"
STATUS_FILE = "/config/lg/devmode_status.json"
RESET_URL = "https://developer.lge.com/secure/ResetDevModeSession.dev?sessionToken="

# The TV's sshd only speaks ssh-rsa, and the agent must not get in the way.
SSH = ["ssh", "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes",
       "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
       "-o", "ConnectTimeout=5", "-o", "HostKeyAlgorithms=+ssh-rsa",
       "-o", "PubkeyAcceptedAlgorithms=+ssh-rsa",
       "-i", KEY, "-p", str(SSH_PORT), f"prisoner@{TV_HOST}",
       "cat /var/luna/preferences/devmode_enabled"]


def read_token_from_tv():
    r = subprocess.run(SSH, capture_output=True, text=True, timeout=20)
    token = r.stdout.strip()
    if r.returncode != 0 or len(token) < 32:
        err = [l for l in r.stderr.splitlines() if l and not l.startswith(("Warning:", "**"))]
        raise RuntimeError(err[-1] if err else f"ssh rc={r.returncode}")
    return token


def load_status():
    try:
        return json.load(open(STATUS_FILE))
    except Exception:
        return {}


def main():
    status = load_status()
    status["checked"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    status.pop("tv_error", None)

    # The token changes only when Developer Mode is re-enabled on the TV; a cached
    # copy lets the reset go out while the TV is off (the call goes to LG, not the TV).
    try:
        token = read_token_from_tv()
        with open(TOKEN_CACHE, "w") as f:
            f.write(token)
        os.chmod(TOKEN_CACHE, 0o600)
        status["token_source"] = "tv"
    except Exception as e:
        status["tv_error"] = str(e)
        if not os.path.exists(TOKEN_CACHE):
            status["result"] = "no token: TV unreachable and nothing cached"
            return finish(status, ok=False)
        token = open(TOKEN_CACHE).read().strip()
        status["token_source"] = "cache"

    try:
        with urllib.request.urlopen(RESET_URL + token, timeout=20) as resp:
            body = json.loads(resp.read().decode())
        status["result"] = body.get("result", "unknown")
        status["lg_response"] = body
        ok = body.get("result") == "success"
    except Exception as e:
        status["result"] = f"error: {e}"
        ok = False
    return finish(status, ok)


def finish(status, ok):
    if ok:
        status["last_success"] = status["checked"]
    with open(STATUS_FILE, "w") as f:
        json.dump(status, f, indent=2)
    print(json.dumps(status))
    return 0 if ok else 1


raise SystemExit(main())
