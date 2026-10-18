// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// Make sure react is setup prior to loading shared components
import '../setup.react';

import { Project } from './Project';
import { mountComponent } from '../../../shared/util/mount';
import { attachBusRealm } from '../hooks/busRealm';

// The editor realm's one bus attachment — shell components (checkout,
// stripe key) ride request('client.*')/host.* ops; the typed project:*
// postMessage protocol is untouched by it.
attachBusRealm();

// Mount the Project view directly — it renders its own TabControl strip.
mountComponent(Project, 'Project');
export default Project;
