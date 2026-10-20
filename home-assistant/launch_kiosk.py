import asyncio, time, os
from aiowebostv import WebOsClient

TV_HOST = "192.168.178.41"
TV_KEY = "74ae6b5823cf0b454689d72067c388fa"
KIOSK_ID = "com.torres.immichscreen"

# Home screen: you may still be navigating it, so give it a grace period.
IDLE_APPS = {"com.webos.app.home"}
IDLE_THRESHOLD = 120

# Things nobody chose to watch: the TV's own screensaver (LG Gallery+) and LG's ad filler.
# The screensaver's presence *is* the idle verdict and wins any race against IDLE_THRESHOLD;
# an ad is never worth a grace period. Both are replaced on sight.
TAKEOVER_APPS = {"com.webos.app.lifeonscreen", "com.webos.app.screensaver", "com.webos.app.videoads"}
TAKEOVER_HINTS = ("lifeonscreen", "screensaver", "videoads")

STATE_FILE = "/tmp/tv_idle_since.txt"


def is_takeover(app_id):
    a = (app_id or "").lower()
    return a in TAKEOVER_APPS or any(h in a for h in TAKEOVER_HINTS)


def clear_state():
    if os.path.exists(STATE_FILE):
        os.remove(STATE_FILE)


async def launch():
    c = WebOsClient(TV_HOST, client_key=TV_KEY)
    await c.connect()
    result = await c.launch_app(KIOSK_ID)
    await c.disconnect()
    print("Launch result:", result)
    clear_state()


async def main():
    client = WebOsClient(TV_HOST, client_key=TV_KEY)
    try:
        await client.connect()
        fg = await client.get_current_app()
        power = await client.get_power_state()
        await client.disconnect()
    except Exception as e:
        print("TV unreachable:", e)
        return

    print("Foreground app:", fg, "| power:", power.get("state"))

    # A standby TV still answers and still reports an app. Launching would wake it.
    # "Screen Saver" is not standby: the screen is on and the TV has judged itself idle.
    if power.get("state") not in ("Active", "Screen Saver"):
        clear_state()
        return

    if fg == KIOSK_ID:
        clear_state()
        return

    if is_takeover(fg) or power.get("state") == "Screen Saver":
        print("TV put up", fg, "/ power", power.get("state"), "— taking over now")
        await launch()
        return

    if fg in IDLE_APPS:
        if os.path.exists(STATE_FILE):
            idle_since = float(open(STATE_FILE).read())
        else:
            idle_since = time.time()
            open(STATE_FILE, "w").write(str(idle_since))

        idle_secs = time.time() - idle_since
        print(f"Idle for {idle_secs:.0f}s (threshold {IDLE_THRESHOLD}s)")

        if idle_secs >= IDLE_THRESHOLD:
            print("Idle threshold reached — launching kiosk")
            await launch()
    else:
        clear_state()
        print("User active in:", fg, "— skipping")


asyncio.run(main())
