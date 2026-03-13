"""KakaoTalk 窗口结构检查工具 — 枚举所有子控件，找到输入框"""

import sys
sys.path.insert(0, ".")

try:
    import win32gui
    import win32con
    import win32api
except ImportError:
    print("pip install pywin32")
    sys.exit(1)


def enum_child_windows(parent_hwnd, depth=0):
    """递归枚举所有子窗口"""
    results = []

    def callback(hwnd, _):
        cls = win32gui.GetClassName(hwnd)
        text = ""
        try:
            text = win32gui.GetWindowText(hwnd)
        except:
            pass
        rect = win32gui.GetWindowRect(hwnd)
        visible = win32gui.IsWindowVisible(hwnd)
        style = win32api.GetWindowLong(hwnd, win32con.GWL_STYLE)

        info = {
            "hwnd": hwnd,
            "class": cls,
            "text": text[:80] if text else "",
            "rect": rect,
            "visible": visible,
            "style": hex(style),
            "depth": depth,
        }
        results.append(info)

        # 递归子窗口
        try:
            win32gui.EnumChildWindows(hwnd, lambda h, _: results.append({
                "hwnd": h,
                "class": win32gui.GetClassName(h),
                "text": win32gui.GetWindowText(h)[:80] if win32gui.GetWindowText(h) else "",
                "rect": win32gui.GetWindowRect(h),
                "visible": win32gui.IsWindowVisible(h),
                "style": hex(win32api.GetWindowLong(h, win32con.GWL_STYLE)),
                "depth": depth + 1,
            }) or True, None)
        except:
            pass
        return True

    try:
        win32gui.EnumChildWindows(parent_hwnd, callback, None)
    except:
        pass
    return results


def find_all_kakao_windows():
    """查找所有 KakaoTalk 相关窗口"""
    windows = []

    def callback(hwnd, _):
        if not win32gui.IsWindowVisible(hwnd):
            return True
        title = win32gui.GetWindowText(hwnd)
        cls = win32gui.GetClassName(hwnd)

        # KakaoTalk 窗口类名
        if "kakao" in cls.lower() or "eva_window" in cls.lower() or \
           "kakao" in title.lower() or cls == "#32770":
            windows.append((hwnd, cls, title))
        return True

    win32gui.EnumWindows(callback, None)
    return windows


def inspect_window(hwnd):
    """详细检查一个窗口的所有子控件"""
    title = win32gui.GetWindowText(hwnd)
    cls = win32gui.GetClassName(hwnd)
    rect = win32gui.GetWindowRect(hwnd)

    print(f"\n{'='*60}")
    print(f"Window: hwnd={hwnd}")
    print(f"  Class: {cls}")
    print(f"  Title: {title}")
    print(f"  Rect:  {rect}")
    print(f"{'='*60}")

    children = []

    def callback(child_hwnd, _):
        child_cls = win32gui.GetClassName(child_hwnd)
        child_text = ""
        try:
            child_text = win32gui.GetWindowText(child_hwnd)
        except:
            pass
        child_rect = win32gui.GetWindowRect(child_hwnd)
        visible = win32gui.IsWindowVisible(child_hwnd)

        children.append({
            "hwnd": child_hwnd,
            "class": child_cls,
            "text": child_text[:60],
            "rect": child_rect,
            "visible": visible,
        })
        return True

    try:
        win32gui.EnumChildWindows(hwnd, callback, None)
    except:
        pass

    print(f"\nChild controls ({len(children)}):")
    for i, c in enumerate(children):
        w = c["rect"][2] - c["rect"][0]
        h = c["rect"][3] - c["rect"][1]
        vis = "V" if c["visible"] else "H"
        edit_marker = " <<<< [EDIT CONTROL]" if "edit" in c["class"].lower() or "richedit" in c["class"].lower() else ""
        button_marker = " <<<< [BUTTON]" if "button" in c["class"].lower() else ""

        print(f"  [{i:3d}] hwnd={c['hwnd']:8d}  class={c['class']:30s}  "
              f"{w:4d}x{h:4d}  {vis}  "
              f"text='{c['text']}'"
              f"{edit_marker}{button_marker}")

    # 特别标记可能的输入框
    print(f"\n--- Likely input controls ---")
    for c in children:
        cls_lower = c["class"].lower()
        if "edit" in cls_lower or "richedit" in cls_lower or \
           "rich_edit" in cls_lower or cls_lower in ("edit", "richedit50w", "richedit20w"):
            print(f"  EDIT: hwnd={c['hwnd']}  class={c['class']}  "
                  f"rect={c['rect']}  text='{c['text']}'")

    return children


def main():
    print("Searching for KakaoTalk windows...\n")
    windows = find_all_kakao_windows()

    if not windows:
        print("No KakaoTalk windows found.")
        print("\nSearching ALL visible windows with 'chat' or Korean text...")
        all_wins = []
        def cb(hwnd, _):
            if win32gui.IsWindowVisible(hwnd):
                t = win32gui.GetWindowText(hwnd)
                c = win32gui.GetClassName(hwnd)
                if t:
                    all_wins.append((hwnd, c, t))
            return True
        win32gui.EnumWindows(cb, None)

        for hwnd, cls, title in sorted(all_wins, key=lambda x: x[2]):
            print(f"  hwnd={hwnd:8d}  class={cls:30s}  title='{title[:60]}'")

        print(f"\nTotal visible windows: {len(all_wins)}")
        print("\nTip: Run with hwnd argument to inspect a specific window:")
        print("  python tools/inspect_kakao.py <hwnd>")
        return

    print(f"Found {len(windows)} KakaoTalk window(s):\n")
    for hwnd, cls, title in windows:
        print(f"  hwnd={hwnd}  class={cls}  title='{title}'")

    # 检查每个窗口
    for hwnd, cls, title in windows:
        inspect_window(hwnd)

    # 如果命令行传了 hwnd，单独检查
    if len(sys.argv) > 1:
        try:
            target = int(sys.argv[1])
            inspect_window(target)
        except ValueError:
            # 按标题搜索
            for hwnd, cls, title in windows:
                if sys.argv[1].lower() in title.lower():
                    inspect_window(hwnd)


if __name__ == "__main__":
    main()
