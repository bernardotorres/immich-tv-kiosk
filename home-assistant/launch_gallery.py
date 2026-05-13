import asyncio
from aiowebostv import WebOsClient

TV_HOST = "192.168.178.41"
TV_KEY = "74ae6b5823cf0b454689d72067c388fa"


async def main():
    client = WebOsClient(TV_HOST, client_key=TV_KEY)
    await client.connect()
    result = await client.launch_app("com.webos.app.videoads")
    print("result:", result)
    await client.disconnect()


asyncio.run(main())
