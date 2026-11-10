"use strict";

// Pure helpers for several hubs on one laptop. Space ids are per hub, so a space is always named with its hub.
(function () {
  /** A Space option value: "s:<hubId>:<spaceId>". */
  const spaceValue = (hubId, spaceId) => `s:${hubId}:${spaceId}`;

  /** The hub and space of an option value, or null (also for a 0.9 "s:<id>" value). */
  function parseSpaceValue(v) {
    const m = /^s:([^:]+):(\d+)$/.exec(String(v));
    return m ? { hubId: m[1], spaceId: Number(m[2]) } : null;
  }

  /** Picking a space on `hubId` moves the folder when another hub links it. */
  const isMove = (row, hubId) => row.hub_id !== null && row.hub_id !== hubId;

  /** One block per hub, in hub order, with that hub's spaces grouped by project. */
  const hubGroups = (hubs, spacesByHub) =>
    hubs.map((hb) => ({ hubId: hb.id, label: hb.label, groups: window.MemSyncCatchup.pickerGroups(spacesByHub[hb.id] || []) }));

  window.MemSyncHubs = { spaceValue, parseSpaceValue, isMove, hubGroups };
})();
