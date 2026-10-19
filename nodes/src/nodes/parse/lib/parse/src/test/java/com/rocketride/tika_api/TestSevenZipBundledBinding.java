package com.rocketride.tika_api;

import static org.junit.jupiter.api.Assertions.*;

import java.io.FileNotFoundException;
import java.nio.file.Path;
import java.nio.file.Paths;

import net.sf.sevenzipjbinding.SevenZip;
import org.junit.jupiter.api.Test;

/**
 * The Linux load path of 7-Zip-JBinding: the engine-built library or nothing.
 *
 * The jar's prebuilt must never be the fallback there, its bundled libstdc++ crashes the
 * task (#2676). Host-independent: no .so, no torch, no engine; runs on every platform.
 */
class TestSevenZipBundledBinding {

    private static Path expected(Path engineRoot) {
        return engineRoot.resolve("nodes").resolve("parse").resolve("lib7-Zip-JBinding.so");
    }

    /** A missing file is refused, and nothing else gets loaded in its place. */
    @Test
    void missingBundledBindingIsRefusedNotReplacedByTheJar() {
        boolean before = SevenZip.isInitializedSuccessfully();
        Path missing = Paths.get("nonexistent-engine", "nodes", "parse", "lib7-Zip-JBinding.so");
        assertThrows(FileNotFoundException.class, () -> TikaApi.loadBundledBinding(missing));
        // Another test in this JVM may have initialized 7-Zip already; the refusal must not
        // change the state either way, least of all by loading the jar's prebuilt.
        assertEquals(before, SevenZip.isInitializedSuccessfully(),
                "a missing bundled binding must not load anything");
    }

    /** No path at all (java.home without a grandparent) is refused the same way. */
    @Test
    void nullPathIsRefusedTheSameWay() {
        boolean before = SevenZip.isInitializedSuccessfully();
        assertThrows(FileNotFoundException.class, () -> TikaApi.loadBundledBinding(null));
        assertEquals(before, SevenZip.isInitializedSuccessfully());
    }

    /** The binding lives two levels above the JVM: dist (java/jre) and dev tree (java/jdk) alike. */
    @Test
    void bundledBindingPathIsTwoLevelsAboveTheJvm() {
        Path dist = Paths.get("opt", "rocketride").toAbsolutePath();
        Path dev = Paths.get("src", "rocketride-server", "build").toAbsolutePath();
        assertEquals(expected(dist), TikaApi.bundledBindingPath(dist.resolve("java").resolve("jre")));
        assertEquals(expected(dev), TikaApi.bundledBindingPath(dev.resolve("java").resolve("jdk")));
        assertEquals(expected(dist), TikaApi.bundledBindingPath(dist.resolve("java").resolve("x").resolve("..").resolve("jre")));
    }
}
