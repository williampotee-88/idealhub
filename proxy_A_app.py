#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
proxy_A_app.py - A 机代理的「无窗口」外壳（用于打包成 exe）

做法：
    双击 exe 后，后台启动 dual_proxy 代理服务，并自动用默认浏览器打开
    状态面板（http://127.0.0.1:10801/）。面板上带「停止代理」按钮，点一下即关闭程序。
    不依赖 tkinter，可在任意 Windows 上打包运行。

运行：
    python proxy_A_app.py
打包：
    pyinstaller --onefile --noconsole --name proxyA proxy_A_app.py
"""

import argparse
import asyncio
import threading
import time
import webbrowser

import dual_proxy

PORT = 10800
WEBPORT = 10801


def build_args():
    a = argparse.Namespace()
    a.host = "127.0.0.1"
    a.port = PORT
    a.web_port = WEBPORT
    a.no_panel = False
    a.verbose = False
    return a


def open_browser():
    # 等服务起来再打开面板
    time.sleep(1.5)
    try:
        webbrowser.open("http://127.0.0.1:%d/" % WEBPORT)
    except Exception:
        pass


def main():
    threading.Thread(target=open_browser, daemon=True).start()
    asyncio.run(dual_proxy.main(build_args()))


if __name__ == "__main__":
    main()
