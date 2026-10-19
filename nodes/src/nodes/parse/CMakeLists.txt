cmake_minimum_required(VERSION 3.20 FATAL_ERROR)

# Everything a C++ node needs to build - see rocketride_add_node for what the
# target gets wired up with
include(${ROCKETRIDE_PACKAGES_DIR}/server/cmake/rocketride-node.cmake)

# The target name is the library base name, and must match the "path" field of
# services.json - that is how the engine finds this library
rocketride_add_node(parse
    scripts/tasks.js
    lib/parse/*)

# Linux: Tika's RAR support loads 7-Zip-JBinding. The prebuilt in the jar carries
# a static GCC 7 libstdc++ whose GNU-unique locale ids collide with the system
# libstdc++ (torch) and crash the task; the sevenzipjbinding vcpkg port builds it
# against the engine's own runtime. It lands beside libparse.so, and nodes:sync
# ships it from there (services.json "libs"). TikaApi loads this copy first.
if(ROCKETRIDE_PLAT_LIN)
    set(sevenZipLib "${VCPKG_INSTALLED_TRIPLET_DIR}/lib/sevenzipjbinding/lib7-Zip-JBinding.so")
    if(NOT EXISTS "${sevenZipLib}")
        message(FATAL_ERROR "parse: ${sevenZipLib} is missing; the sevenzipjbinding vcpkg port did not install")
    endif()
    set(sevenZipCopy "${CMAKE_CURRENT_BINARY_DIR}/lib7-Zip-JBinding.so")
    # A tracked dependency rather than a POST_BUILD step: a rebuilt port refreshes
    # the copy even when libparse.so itself is up to date.
    add_custom_command(OUTPUT "${sevenZipCopy}"
        COMMAND ${CMAKE_COMMAND} -E copy_if_different "${sevenZipLib}" "${sevenZipCopy}"
        DEPENDS "${sevenZipLib}"
        COMMENT "Copying lib7-Zip-JBinding.so beside libparse.so")
    add_custom_target(parse_sevenzipjbinding ALL DEPENDS "${sevenZipCopy}")
    add_dependencies(parse parse_sevenzipjbinding)
    # CMake-kit (IDE) builds stage node libraries into dist themselves (rocketride-node.cmake
    # does it for libparse.so); nodes:sync is not part of that flow, so stage this one too.
    if(ROCKETRIDE_CMAKE_KITS)
        set(sevenZipDist "${ROCKETRIDE_DIST_DIR}/nodes/parse/lib7-Zip-JBinding.so")
        add_custom_command(OUTPUT "${sevenZipDist}"
            COMMAND ${CMAKE_COMMAND} -E make_directory "${ROCKETRIDE_DIST_DIR}/nodes/parse"
            COMMAND ${CMAKE_COMMAND} -E copy_if_different "${sevenZipCopy}" "${sevenZipDist}"
            DEPENDS "${sevenZipCopy}"
            COMMENT "Copying lib7-Zip-JBinding.so to dist/server/nodes/parse")
        add_custom_target(parse_sevenzipjbinding_dist ALL DEPENDS "${sevenZipDist}")
        add_dependencies(parse parse_sevenzipjbinding_dist)
    endif()
endif()
