import asyncio, time, os
from aiowebostv import WebOsClient

TV_HOST = "192.168.178.41"
TV_KEY = "74ae6b5823cf0b454689d72067c388fa"
KIOSK_ID = "com.torres.immichscreen"
IDLE_APPS = {"com.webos.app.home", "com.webos.app.videoads"}
IDLE_THRESHOLD = 600  # 10 minutes
STATE_FILE = "/tmp/tv_idle_since.txt"


async def main():
    client = WebOsClient(TV_HOST, client_key=TV_KEY)
    try:
        await client.connect()
        fg = await client.get_current_app()
        await client.disconnect()
    except Exception as e:
        print("TV unreachable:", e)
        return

    print("Foreground app:", fg)

    if fg == KIOSK_ID:
        if os.path.exists(STATE_FILE):
            os.remove(STATE_FILE)
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
            c2 = WebOsClient(TV_HOST, client_key=TV_KEY)
            await c2.connect()
            result = await c2.launch_app(KIOSK_ID)
            print("Launch result:", result)
            await c2.disconnect()
            if os.path.exists(STATE_FILE):
                os.remove(STATE_FILE)
    else:
        if os.path.exists(STATE_FILE):
            os.remove(STATE_FILE)
        print("User active in:", fg, "— skipping")


asyncio.run(main())
