// Immutable templates for a brand-new organization. Never copy these rows from
// an existing tenant: labels and descriptions become editable tenant data.

export const organizationSystemRoles = [
  {
    key: "admin",
    name: "Admin",
    description:
      "Full organization access, including users, roles, settings, and API tokens.",
  },
  {
    key: "editor",
    name: "Editor",
    description:
      "Can work with inventory and operational workflows without organization administration.",
  },
  {
    key: "viewer",
    name: "Viewer",
    description: "Read-only access to inventory and operational records.",
  },
] as const;

export const canonicalInventoryTypes = [
  {
    key: "place",
    label: "Place / room",
    description: "A site, building, room, zone, shelf, or other place.",
    color: "#16a374",
    icon: "map-pin",
    canContain: true,
    spatialContainment: true,
    position: 10,
  },
  {
    key: "furniture",
    label: "Furniture",
    description: "Furniture and fixtures which may contain other items.",
    color: "#b9875e",
    icon: "armchair",
    canContain: true,
    spatialContainment: true,
    position: 20,
  },
  {
    key: "vehicle",
    label: "Vehicle",
    description: "Vehicles and mobile containers.",
    color: "#3b82f6",
    icon: "car",
    canContain: true,
    spatialContainment: true,
    position: 30,
  },
  {
    key: "tool",
    label: "Tool",
    description: "Tools and workshop equipment.",
    color: "#e99b2d",
    icon: "wrench",
    canContain: false,
    spatialContainment: false,
    position: 40,
  },
  {
    key: "object",
    label: "Object",
    description: "General physical objects and stock items.",
    color: "#635bff",
    icon: "box",
    canContain: false,
    spatialContainment: false,
    position: 50,
  },
  {
    key: "clothing",
    label: "Clothing",
    description: "Clothing and wearable equipment.",
    color: "#e2647f",
    icon: "shirt",
    canContain: false,
    spatialContainment: false,
    position: 60,
  },
  {
    key: "person",
    label: "Person",
    description: "A person represented inside the inventory graph.",
    color: "#a66dd4",
    icon: "user",
    canContain: false,
    spatialContainment: false,
    position: 70,
  },
  {
    key: "project",
    label: "Project",
    description: "A project or logical collection.",
    color: "#64748b",
    icon: "folder",
    canContain: true,
    spatialContainment: false,
    position: 80,
  },
  {
    key: "other",
    label: "Other",
    description: "Fallback type for records which do not fit another type.",
    color: "#858b95",
    icon: "shapes",
    canContain: false,
    spatialContainment: false,
    position: 90,
  },
] as const;

export const canonicalRelationTypes = [
  {
    key: "contains",
    label: "Contains",
    inverseLabel: "Located in",
    description:
      "Physical or logical containment. Spatial edges are recalculated from map geometry.",
    allowManual: true,
    spatial: true,
    position: 10,
  },
  {
    key: "variant_of",
    label: "Variant of",
    inverseLabel: "Variants",
    description:
      "Connects a first-class inventory variant to its primary item.",
    allowManual: false,
    spatial: false,
    position: 15,
  },
  {
    key: "related",
    label: "Related to",
    inverseLabel: "Related to",
    description: "A general relationship without containment semantics.",
    allowManual: true,
    spatial: false,
    position: 20,
  },
] as const;
