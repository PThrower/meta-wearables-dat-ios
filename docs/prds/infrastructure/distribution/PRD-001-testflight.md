# PRD-001: TestFlight Distribution

## Status: PENDING

Blocked by [prerequisite — TBD].

## Bundle ID

`com.meta.wearables.external.CameraAccess`

## Apple Developer Team

`42R8ZPM5N8`

## Requirements

- App Store Connect app record exists
- API key or app-specific password for upload
- Archive build with Release configuration
- Upload via `xcodebuild archive` + `xcrun altool --upload-app`

## Steps

1. Resolve prerequisite (TBD)
2. Create Release archive: `xcodebuild archive -scheme CameraAccess -configuration Release -archivePath build/CameraAccess.xcarchive`
3. Export IPA: `xcodebuild -exportArchive -archivePath build/CameraAccess.xcarchive -exportOptionsPlist ExportOptions.plist -exportPath build/`
4. Upload to App Store Connect: `xcrun altool --upload-app -f build/CameraAccess.ipa -t ios --apiKey KEY --apiIssuer ISSUER`
5. Add testers in App Store Connect
6. Distribute via TestFlight

## Notes

- Bidirectional audio feature (FRAU push to publisher) is implemented and tested on `feat/stream-registry` branch
- Merge to `dev` before TestFlight build
