// Projection of the official Security 3.9.0.0 static action groups.
// Source: https://github.com/opensearch-project/security/blob/3.9.0.0/src/main/resources/static_config/static_action_groups.yml
// Source SHA-256: 0e0b87756f49cb31eaa1adb435da900335832bd77e9037753d241c6c8f9d8a54; Apache-2.0.
// Projected fields only; upstream license and NOTICE are retained in packages/search/vendor/.
// Only these immutable built-ins may accompany Station's empty custom action_groups.yml.
export const PINNED_STATIC_ACTION_GROUPS = {
  "kibana_all_write": {
    "allowed_actions": [
      "kibana:saved_objects/*/write"
    ],
    "description": "Allow writing in all OpenSearch Dashboards apps",
    "hidden": false,
    "reserved": true,
    "static": true,
    "type": "kibana"
  },
  "kibana_all_read": {
    "allowed_actions": [
      "kibana:saved_objects/*/read"
    ],
    "description": "Allow reading in all OpenSearch Dashboards apps",
    "hidden": false,
    "reserved": true,
    "static": true,
    "type": "kibana"
  },
  "cluster_all": {
    "allowed_actions": [
      "cluster:*"
    ],
    "description": "Allow everything on cluster level",
    "hidden": false,
    "reserved": true,
    "static": true,
    "type": "cluster"
  },
  "crud": {
    "allowed_actions": [
      "read",
      "write"
    ],
    "description": "Allow all read/write operations on data",
    "hidden": false,
    "reserved": true,
    "static": true,
    "type": "index"
  },
  "search": {
    "allowed_actions": [
      "indices:data/read/search*",
      "indices:data/read/msearch*",
      "indices:admin/resolve/index",
      "suggest"
    ],
    "description": "Allow searching",
    "hidden": false,
    "reserved": true,
    "static": true,
    "type": "index"
  },
  "data_access": {
    "allowed_actions": [
      "indices:data/*",
      "crud"
    ],
    "description": "Allow all read/write operations on data",
    "hidden": false,
    "reserved": true,
    "static": true,
    "type": "index"
  },
  "create_index": {
    "allowed_actions": [
      "indices:admin/create",
      "indices:admin/mapping/put"
    ],
    "description": "Allow creating new indices",
    "hidden": false,
    "reserved": true,
    "static": true,
    "type": "index"
  },
  "write": {
    "allowed_actions": [
      "indices:data/write*",
      "indices:admin/mapping/put"
    ],
    "description": "Allow writing data",
    "hidden": false,
    "reserved": true,
    "static": true,
    "type": "index"
  },
  "manage_aliases": {
    "allowed_actions": [
      "indices:admin/aliases*"
    ],
    "description": "Allow managing index aliases",
    "hidden": false,
    "reserved": true,
    "static": true,
    "type": "index"
  },
  "read": {
    "allowed_actions": [
      "indices:data/read*",
      "indices:admin/mappings/fields/get*",
      "indices:admin/resolve/index"
    ],
    "description": "Allow all read operations",
    "hidden": false,
    "reserved": true,
    "static": true,
    "type": "index"
  },
  "indices_all": {
    "allowed_actions": [
      "indices:*"
    ],
    "description": "Allow readonly everything with indices and data",
    "hidden": false,
    "reserved": true,
    "static": true,
    "type": "index"
  },
  "delete": {
    "allowed_actions": [
      "indices:data/write/delete*"
    ],
    "description": "Allow deleting documents",
    "hidden": false,
    "reserved": true,
    "static": true,
    "type": "index"
  },
  "cluster_composite_ops": {
    "allowed_actions": [
      "indices:data/write/bulk",
      "indices:admin/aliases*",
      "indices:data/write/reindex",
      "cluster_composite_ops_ro"
    ],
    "description": "Allow read/write bulk and m* operations",
    "hidden": false,
    "reserved": true,
    "static": true,
    "type": "cluster"
  },
  "cluster_composite_ops_ro": {
    "allowed_actions": [
      "indices:data/read/mget",
      "indices:data/read/msearch",
      "indices:data/read/mtv",
      "indices:admin/aliases/exists*",
      "indices:admin/aliases/get*",
      "indices:data/read/scroll",
      "indices:admin/resolve/index"
    ],
    "description": "Allow readonly bulk and m* operations",
    "hidden": false,
    "reserved": true,
    "static": true,
    "type": "cluster"
  },
  "get": {
    "allowed_actions": [
      "indices:data/read/get*",
      "indices:data/read/mget*"
    ],
    "description": "Allow get",
    "hidden": false,
    "reserved": true,
    "static": true,
    "type": "index"
  },
  "manage": {
    "allowed_actions": [
      "indices:monitor/*",
      "indices:admin/*"
    ],
    "description": "Allow indices management",
    "hidden": false,
    "reserved": true,
    "static": true,
    "type": "index"
  },
  "cluster_monitor": {
    "allowed_actions": [
      "cluster:monitor/*"
    ],
    "description": "Allow monitoring the cluster",
    "hidden": false,
    "reserved": true,
    "static": true,
    "type": "cluster"
  },
  "manage_snapshots": {
    "allowed_actions": [
      "cluster:admin/snapshot/*",
      "cluster:admin/repository/*"
    ],
    "description": "Allow snapshots",
    "hidden": false,
    "reserved": true,
    "static": true,
    "type": "cluster"
  },
  "index": {
    "allowed_actions": [
      "indices:data/write/index*",
      "indices:data/write/update*",
      "indices:admin/mapping/put",
      "indices:data/write/bulk*"
    ],
    "description": "Allow indexing",
    "hidden": false,
    "reserved": true,
    "static": true,
    "type": "index"
  },
  "unlimited": {
    "allowed_actions": [
      "*"
    ],
    "description": "Allow all",
    "hidden": false,
    "reserved": true,
    "static": true,
    "type": "all"
  },
  "indices_monitor": {
    "allowed_actions": [
      "indices:monitor/*"
    ],
    "description": "Allow monitoring indices",
    "hidden": false,
    "reserved": true,
    "static": true,
    "type": "index"
  },
  "suggest": {
    "allowed_actions": [
      "indices:data/read/suggest*"
    ],
    "description": "Allow suggestions",
    "hidden": false,
    "reserved": true,
    "static": true,
    "type": "index"
  },
  "cluster_manage_index_templates": {
    "allowed_actions": [
      "indices:admin/template/*",
      "indices:admin/index_template/*",
      "cluster:admin/component_template/*"
    ],
    "description": "Manage index templates",
    "hidden": false,
    "reserved": true,
    "static": true,
    "type": "cluster"
  },
  "cluster_manage_pipelines": {
    "allowed_actions": [
      "cluster:admin/ingest/pipeline/*"
    ],
    "description": "Manage pipelines",
    "hidden": false,
    "reserved": true,
    "static": true,
    "type": "cluster"
  },
  "manage_data_streams": {
    "allowed_actions": [
      "indices:admin/data_stream/*",
      "indices:monitor/data_stream/stats"
    ],
    "description": "Manage data streams",
    "hidden": false,
    "reserved": true,
    "static": true,
    "type": "index"
  },
  "manage_point_in_time": {
    "allowed_actions": [
      "indices:data/read/point_in_time/create",
      "indices:data/read/point_in_time/delete",
      "indices:data/read/point_in_time/readall",
      "indices:data/read/search",
      "indices:monitor/point_in_time/segments"
    ],
    "description": "Manage point in time actions",
    "hidden": false,
    "reserved": true,
    "static": true,
    "type": "index"
  }
} as const;
