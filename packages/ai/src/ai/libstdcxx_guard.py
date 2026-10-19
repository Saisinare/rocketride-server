# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Make the system libstdc++ own its GNU-unique symbols before any JNI library can.

Safety net, not the fix (the fix is the parse node's own build of lib7-Zip-JBinding.so,
vcpkg port ``sevenzipjbinding``, engine toolchain, libc++, which carries no C++ runtime of
its own). This guard is for the next native library that does. The jar's prebuilt binding
did: a statically linked GCC 7 libstdc++, exported, with 106 ``STB_GNU_UNIQUE`` symbols
(all 40 locale facet ids among them) under the same names ``libstdc++.so.6`` defines.
glibc binds a GNU-unique name process-wide to the first copy looked up, ``RTLD_LOCAL`` or
not, so loaded first such a library numbers the shared facet ids with its own counter, and
the first GCC-built stream that formats a number (torch, on import) calls the wrong facet
and dies at address 0x20. With ``libstdc++.so.6`` global beforehand, one runtime numbers
the ids.

Called by ``ai/node.py`` before any node code; ``nodes/test/parse`` exercises it on the
jar's prebuilt binding.
"""

from __future__ import annotations

import sys

SYSTEM_LIBSTDCXX = 'libstdc++.so.6'


def preload_system_libstdcxx() -> bool:
    """
    Load the system libstdc++ into the global symbol scope (Linux only).

    Fails open: a host without ``libstdc++.so.6`` cannot load GCC-built code either, so
    there is nothing to guard; a warning goes to stderr.

    Returns:
        True when the library is now in the global scope, False otherwise.
    """
    if not sys.platform.startswith('linux'):
        return False
    import ctypes
    import os

    try:
        ctypes.CDLL(SYSTEM_LIBSTDCXX, os.RTLD_NOW | os.RTLD_GLOBAL)
    except OSError as e:
        print(f'warning: could not preload {SYSTEM_LIBSTDCXX}: {e}', file=sys.stderr)
        return False
    return True
