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
