import Cocoa
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var fallbackBackend: Process?
    private let appURL = URL(string: "http://127.0.0.1:4173/")!

    func applicationDidFinishLaunching(_ notification: Notification) {
        setupMenus()

        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")

        let contentRect = NSRect(x: 0, y: 0, width: 1120, height: 760)
        window = NSWindow(
            contentRect: contentRect,
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "NITC HQ Tasks"
        window.appearance = NSAppearance(named: .darkAqua)
        window.titlebarAppearsTransparent = true
        window.backgroundColor = NSColor(calibratedRed: 0.039, green: 0.078, blue: 0.188, alpha: 1.0)
        window.minSize = NSSize(width: 360, height: 520)
        window.center()
        window.setFrameAutosaveName("NITCHQTasksMainWindow")
        window.delegate = self

        webView = WKWebView(frame: window.contentView!.bounds, configuration: config)
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        webView.setValue(false, forKey: "drawsBackground")
        window.contentView?.addSubview(webView)

        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        loadAppWithFallback()
    }

    private func loadAppWithFallback() {
        let healthURL = URL(string: "http://127.0.0.1:4173/api/health")!
        var req = URLRequest(url: healthURL)
        req.timeoutInterval = 1.5
        URLSession.shared.dataTask(with: req) { [weak self] _, response, _ in
            guard let self = self else { return }
            if let http = response as? HTTPURLResponse, http.statusCode == 200 {
                DispatchQueue.main.async { self.webView.load(URLRequest(url: self.appURL)) }
            } else {
                self.startFallbackBackend()
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
                    self.webView.load(URLRequest(url: self.appURL))
                }
            }
        }.resume()
    }

    private func startFallbackBackend() {
        guard fallbackBackend == nil else { return }
        guard let binURL = Bundle.main.url(forAuxiliaryExecutable: "nitc-hq-backend") else { return }
        let proc = Process()
        proc.executableURL = binURL
        var env = ProcessInfo.processInfo.environment
        env["NITC_PROJECT_ROOT"] = "/Users/devangagarwal/Developer/nitc-hq-tasks"
        env["PORT"] = "4173"
        proc.environment = env
        do {
            try proc.run()
            fallbackBackend = proc
        } catch {
            NSLog("Failed to start bundled nitc-hq-backend: \(error)")
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        if let proc = fallbackBackend, proc.isRunning {
            proc.terminate()
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return true
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { window.makeKeyAndOrderFront(nil) }
        return true
    }

    // Pause live background themes whenever the window is minimized or occluded (0% GPU)
    func windowDidChangeOcclusionState(_ notification: Notification) {
        let visible = window.occlusionState.contains(.visible) && !window.isMiniaturized
        setWebVisibility(visible)
    }

    func windowDidMiniaturize(_ notification: Notification) {
        setWebVisibility(false)
    }

    func windowDidDeminiaturize(_ notification: Notification) {
        setWebVisibility(true)
    }

    private func setWebVisibility(_ visible: Bool) {
        webView?.evaluateJavaScript("window.__nitcSetWindowVisible?.(\(visible ? "true" : "false"))", completionHandler: nil)
    }

    // Keep local app navigation inside WebView; open external links in default browser
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.allow)
            return
        }
        if url.host == "127.0.0.1" || url.host == "localhost" {
            decisionHandler(.allow)
        } else {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
        }
    }

    // Native menu actions
    @objc private func reloadPage() { webView.reload() }
    @objc private func triggerNewTask() { webView.evaluateJavaScript("document.querySelector('#new-task')?.click()", completionHandler: nil) }
    @objc private func triggerCycleTheme() { webView.evaluateJavaScript("document.querySelector('#theme-cycle')?.click()", completionHandler: nil) }
    @objc private func triggerStudyMode() { webView.evaluateJavaScript("document.querySelector('[data-view=\"study\"]')?.click()", completionHandler: nil) }

    private func setupMenus() {
        let mainMenu = NSMenu()

        // App Menu
        let appItem = NSMenuItem()
        let appMenu = NSMenu(title: "NITC HQ Tasks")
        appMenu.addItem(withTitle: "Hide NITC HQ Tasks", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit NITC HQ Tasks", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        mainMenu.addItem(appItem)

        // Edit Menu (enables native Cut/Copy/Paste/Select All in WKWebView inputs)
        let editItem = NSMenuItem()
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu
        mainMenu.addItem(editItem)

        // View Menu
        let viewItem = NSMenuItem()
        let viewMenu = NSMenu(title: "View")
        let newTaskItem = NSMenuItem(title: "New Task", action: #selector(triggerNewTask), keyEquivalent: "n")
        newTaskItem.target = self
        viewMenu.addItem(newTaskItem)

        let studyItem = NSMenuItem(title: "Study Timer", action: #selector(triggerStudyMode), keyEquivalent: "S")
        studyItem.target = self
        viewMenu.addItem(studyItem)

        let themeItem = NSMenuItem(title: "Next Theme", action: #selector(triggerCycleTheme), keyEquivalent: "T")
        themeItem.target = self
        viewMenu.addItem(themeItem)

        viewMenu.addItem(.separator())
        let reloadItem = NSMenuItem(title: "Reload", action: #selector(reloadPage), keyEquivalent: "r")
        reloadItem.target = self
        viewMenu.addItem(reloadItem)

        viewItem.submenu = viewMenu
        mainMenu.addItem(viewItem)

        // Window Menu
        let winItem = NSMenuItem()
        let winMenu = NSMenu(title: "Window")
        winMenu.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        winMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        winMenu.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        winItem.submenu = winMenu
        mainMenu.addItem(winItem)

        NSApp.mainMenu = mainMenu
        NSApp.windowsMenu = winMenu
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
