import Foundation
import UserNotifications
import Capacitor

/// Posts approval notifications immediately (ApprovalNotifierPlugin.java on Android; same JS
/// contract, see src/mobile/notifications.ts). Text names the dApp and the kind of request, never
/// amounts or addresses; `.hiddenPreviewsBodyPlaceholder` keeps even that off a locked screen when
/// the user has previews hidden.
///
/// iOS suspends a backgrounded app within seconds, so this only fires for requests that arrive in
/// that short window; later ones wait at the WalletConnect relay until Sapient is opened (true push
/// would need a push server).
@objc(ApprovalNotifierPlugin)
public class ApprovalNotifierPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ApprovalNotifierPlugin"
    public let jsName = "ApprovalNotifier"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "show", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise),
    ]

    private static let categoryId = "sapient-approval"

    override public func load() {
        let category = UNNotificationCategory(
            identifier: Self.categoryId,
            actions: [],
            intentIdentifiers: [],
            hiddenPreviewsBodyPlaceholder: "A request is waiting for your approval",
            options: []
        )
        UNUserNotificationCenter.current().setNotificationCategories([category])
    }

    @objc func show(_ call: CAPPluginCall) {
        guard let id = call.getInt("id") else {
            call.reject("id is required", "BAD_ARGS")
            return
        }
        let content = UNMutableNotificationContent()
        content.title = call.getString("title", "Sapient")
        content.body = call.getString("body", "")
        content.sound = .default
        content.categoryIdentifier = Self.categoryId
        // nil trigger = deliver now. Unauthorized: silently not shown, as on Android.
        let request = UNNotificationRequest(identifier: "approval-\(id)", content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request) { _ in call.resolve() }
    }

    @objc func cancel(_ call: CAPPluginCall) {
        if let id = call.getInt("id") {
            let ids = ["approval-\(id)"]
            UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: ids)
            UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: ids)
        }
        call.resolve()
    }
}
