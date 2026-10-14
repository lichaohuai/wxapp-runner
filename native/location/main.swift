import AppKit
import CoreLocation

// This helper only speaks JSON on stdin/stdout. It never stores coordinates.
final class LocationDelegate: NSObject, NSApplicationDelegate, CLLocationManagerDelegate {
    let manager = CLLocationManager()
    let request: [String: Any]
    var finished = false
    var started = false
    var timer: Timer?
    var best: CLLocation?
    init(_ request: [String: Any]) { self.request = request; super.init() }

    func status() -> String {
        if !CLLocationManager.locationServicesEnabled() { return "disabled" }
        switch manager.authorizationStatus {
        case .notDetermined: return "notDetermined"
        case .restricted: return "restricted"
        case .denied: return "denied"
        case .authorizedAlways, .authorizedWhenInUse: return "authorized"
        @unknown default: return "unknown"
        }
    }
    func finish(_ value: [String: Any]) {
        guard !finished else { return }
        finished = true
        timer?.invalidate()
        manager.stopUpdatingLocation()
        if let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) {
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write(Data([10]))
        }
        NSApplication.shared.terminate(nil)
    }
    func fail(_ code: String, _ message: String) {
        finish(["ok": false, "code": code, "message": message, "authorization": status()])
    }
    func applicationDidFinishLaunching(_ notification: Notification) {
        manager.delegate = self
        if request["action"] as? String == "status" {
            finish(["ok": true, "authorization": status(), "provider": "CoreLocation"])
            return
        }
        let timeout = min(60000, max(1000, request["timeoutMs"] as? Double ?? 10000)) / 1000
        timer = Timer.scheduledTimer(withTimeInterval: timeout, repeats: false) { [self] _ in
            if let fix = best { complete(fix) }
            else { fail("LOCATION_TIMEOUT", "location timeout") }
        }
        if status() == "notDetermined" {
            NSApplication.shared.activate(ignoringOtherApps: true)
            manager.requestWhenInUseAuthorization()
        } else { authorized() }
    }
    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) { authorized() }
    func authorized() {
        guard !finished, request["action"] as? String != "status" else { return }
        switch status() {
        case "authorized":
            guard !started else { return }
            started = true
            manager.desiredAccuracy = request["highAccuracy"] as? Bool == true
                ? kCLLocationAccuracyBest : kCLLocationAccuracyHundredMeters
            manager.startUpdatingLocation()
        case "notDetermined": break
        case "disabled": fail("LOCATION_SERVICES_DISABLED", "system location services disabled")
        case "denied", "restricted": fail("LOCATION_SYSTEM_DENIED", "system location permission denied; enable WxappRunner Location in System Settings > Privacy & Security > Location Services")
        default: fail("LOCATION_UNAVAILABLE", "system location authorization unavailable")
        }
    }
    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard !finished else { return }
        for fix in locations where fix.horizontalAccuracy >= 0 && abs(fix.timestamp.timeIntervalSinceNow) <= 30 {
            if best == nil || fix.horizontalAccuracy < best!.horizontalAccuracy { best = fix }
        }
        if let fix = best, request["highAccuracy"] as? Bool != true || fix.horizontalAccuracy <= 10 { complete(fix) }
    }
    func complete(_ fix: CLLocation) {
        var result: [String: Any] = [
            "ok": true, "provider": "CoreLocation", "authorization": status(),
            "latitude": fix.coordinate.latitude, "longitude": fix.coordinate.longitude,
            "accuracy": fix.horizontalAccuracy, "timestamp": fix.timestamp.timeIntervalSince1970 * 1000
        ]
        // Negative CoreLocation accuracies/speeds mean unavailable, not zero.
        if fix.speed >= 0 { result["speed"] = fix.speed }
        if fix.verticalAccuracy >= 0 {
            result["altitude"] = fix.altitude
            result["verticalAccuracy"] = fix.verticalAccuracy
        }
        finish(result)
    }
    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        let e = error as NSError
        if e.domain == kCLErrorDomain && e.code == CLError.locationUnknown.rawValue { return }
        fail(e.code == CLError.denied.rawValue ? "LOCATION_SYSTEM_DENIED" : "LOCATION_UNAVAILABLE", error.localizedDescription)
    }
}

let input = FileHandle.standardInput.readDataToEndOfFile()
let request = (try? JSONSerialization.jsonObject(with: input)) as? [String: Any] ?? [:]
let application = NSApplication.shared
application.setActivationPolicy(.accessory)
let delegate = LocationDelegate(request)
application.delegate = delegate
application.run()
