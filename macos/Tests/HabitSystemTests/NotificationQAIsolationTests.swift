import Foundation
import XCTest

final class NotificationQAIsolationTests: XCTestCase {
  func testQARequiresCompileFlagAndDedicatedBundleIdentity() {
    let identifier = "studio.orbitlabs.habitsystem.mac.notificationqa"
    let qa = AppRuntimePolicy(notificationQABuild: true, bundleIdentifier: identifier)
    XCTAssertTrue(qa.notificationQA)
    XCTAssertTrue(qa.requiresQAStore)
    XCTAssertTrue(qa.allowsNotifications(sampleMode: false, isolatedStore: true))
    XCTAssertFalse(qa.allowsCloud(sampleMode: false, isolatedStore: false))
    XCTAssertFalse(qa.allowsNotifications(sampleMode: true, isolatedStore: true))

    let wronglySignedQA = AppRuntimePolicy(notificationQABuild: true, bundleIdentifier: "studio.orbitlabs.habitsystem.mac")
    XCTAssertTrue(wronglySignedQA.requiresQAStore)
    XCTAssertFalse(wronglySignedQA.notificationQA)
    XCTAssertFalse(wronglySignedQA.allowsNotifications(sampleMode: false, isolatedStore: false))
    XCTAssertFalse(wronglySignedQA.allowsCloud(sampleMode: false, isolatedStore: false))

    let renamedProduction = AppRuntimePolicy(notificationQABuild: false, bundleIdentifier: identifier)
    XCTAssertFalse(renamedProduction.notificationQA)
    XCTAssertFalse(renamedProduction.allowsNotifications(sampleMode: false, isolatedStore: true))
  }

  func testOrdinaryIsolatedStoresAndSamplesKeepAllExternalEffectsDisabled() {
    let product = AppRuntimePolicy(notificationQABuild: false, bundleIdentifier: "studio.orbitlabs.habitsystem.mac")
    XCTAssertTrue(product.allowsNotifications(sampleMode: false, isolatedStore: false))
    XCTAssertTrue(product.allowsCloud(sampleMode: false, isolatedStore: false))
    XCTAssertFalse(product.allowsNotifications(sampleMode: false, isolatedStore: true))
    XCTAssertFalse(product.allowsCloud(sampleMode: false, isolatedStore: true))
    XCTAssertFalse(product.allowsNotifications(sampleMode: true, isolatedStore: false))
    XCTAssertFalse(product.allowsCloud(sampleMode: true, isolatedStore: false))
  }
}
