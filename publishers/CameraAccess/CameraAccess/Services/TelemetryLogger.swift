import os.log

enum TelemetryLogger {
    private static let subsystem = "com.mwdat.cameraaccess.telemetry"

    static let session = Logger(subsystem: subsystem, category: "session")
    static let frames = Logger(subsystem: subsystem, category: "frames")
    static let errors = Logger(subsystem: subsystem, category: "errors")
    static let connection = Logger(subsystem: subsystem, category: "connection")
    static let photos = Logger(subsystem: subsystem, category: "photos")
}
