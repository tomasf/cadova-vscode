import Cadova
// Model("commented")
/* Model("block /* nested */ comment") */
await Project {
    let s = "Model(\"inString\") { }"
    await Model("top") { Box(1) }
    Group("parts") {
        Model("bolt") { Box(1) }
        Group(options: .format3D(.stl)) {
            Model("nut\(1)") { }
            Model("washer", options: .x) { Box(x: "}") }
        }
        Group("sub/dir", options: .y) {
            Model(#"raw"#) { }
        }
    }
    Group("\(name)") { Model("hidden") { } }
    Model("""
        multi
        """) { }
    Model("after") { }
}
