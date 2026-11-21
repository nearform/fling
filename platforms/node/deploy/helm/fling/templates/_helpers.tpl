{{- define "fling.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "fling.labels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Values.image.tag | toString | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{- define "fling.selector" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "fling.secretName" -}}
{{- .Values.secrets.existingSecret | default (include "fling.fullname" .) -}}
{{- end -}}

{{- define "fling.image" -}}
{{- printf "%s:%s" .Values.image.repository (.Values.image.tag | required "image.tag (the Fling release) is required" | toString) -}}
{{- end -}}

{{/* The sites domain as a host name, for the Ingress (no port). */}}
{{- define "fling.sitesHost" -}}
{{- .Values.instance.sitesDomain | required "instance.sitesDomain is required" -}}
{{- end -}}

{{/* The migrate Job's labels: never the Deployment's selector, so the Service never routes to it. */}}
{{- define "fling.migrateLabels" -}}
app.kubernetes.io/name: {{ printf "%s-migrate" .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: migrate
app.kubernetes.io/version: {{ .Values.image.tag | toString | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{/*
Site servers stay off: the Node host runs them as child processes, which isolate nothing. Refuse
SERVERS set to anything else, in env or in the secrets.
*/}}
{{- define "fling.refuseServers" -}}
{{- range $source := list .Values.env .Values.secrets.extra -}}
{{- range $key, $value := $source -}}
{{- if and (eq (upper $key) "SERVERS") (ne (lower (trim (toString $value))) "off") -}}
{{- fail "SERVERS must be off: the Node host's site servers are child processes, which isolate nothing (platforms/node/DEPLOY.md, Site servers)" -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}
