use std::{
    env, fs,
    path::{Path, PathBuf},
};
fn collect(root: &Path, path: &Path, entries: &mut Vec<String>) {
    for entry in fs::read_dir(path).expect("read Web assets") {
        let path = entry.expect("Web asset").path();
        if path.is_dir() {
            collect(root, &path, entries);
        } else {
            let name = path
                .strip_prefix(root)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            entries.push(format!(
                "({name:?}, include_bytes!({:?}) as &'static [u8])",
                path.to_string_lossy()
            ));
        }
    }
}
fn main() {
    let root = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap()).join("../web/dist");
    println!("cargo:rerun-if-changed={}", root.display());
    let mut entries = Vec::new();
    if root.join("index.html").exists() {
        collect(&root, &root, &mut entries);
    }
    fs::write(
        PathBuf::from(env::var("OUT_DIR").unwrap()).join("web.rs"),
        format!(
            "pub static WEB_ASSETS: &[(&str, &[u8])] = &[{}];",
            entries.join(",")
        ),
    )
    .unwrap();
}
