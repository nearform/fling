# Live rooms (review mode's realtime): an API Gateway WebSocket API in front of the same function.
# $connect admits the ticket the app issued (POST /api/sites/:name/live) and stores the connection
# in the table; $default relays a client's messages; $disconnect forgets it. The function posts to
# connections through the management API, so it may manage this API's connections and nothing else.
#
# Clients learn the URL from the app (LIVE_URL, set on the function below), never from here. Every
# message, each way it is relayed, is one function invocation (DEPLOY.md, costs).

resource "aws_apigatewayv2_api" "live" {
  name                       = "${local.name}-live"
  description                = "${var.name} (${var.env}) live rooms."
  protocol_type              = "WEBSOCKET"
  route_selection_expression = "$request.body.type"
}

resource "aws_apigatewayv2_integration" "live" {
  api_id             = aws_apigatewayv2_api.live.id
  integration_type   = "AWS_PROXY"
  integration_method = "POST"
  integration_uri    = aws_lambda_function.api.invoke_arn
}

resource "aws_apigatewayv2_route" "live" {
  for_each = toset(["$connect", "$disconnect", "$default"])

  api_id    = aws_apigatewayv2_api.live.id
  route_key = each.value
  target    = "integrations/${aws_apigatewayv2_integration.live.id}"
}

resource "aws_apigatewayv2_stage" "live" {
  api_id      = aws_apigatewayv2_api.live.id
  name        = local.live_stage
  auto_deploy = true

  # Pointers are throttled in the client (about 12 a second each); this caps the whole API.
  default_route_settings {
    throttling_burst_limit = 200
    throttling_rate_limit  = 100
  }

  depends_on = [aws_apigatewayv2_route.live]
}

resource "aws_lambda_permission" "live" {
  statement_id  = "AllowLiveWebSocketApi"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.live.execution_arn}/*"
}

locals {
  live_stage = "live"
  # wss://<api id>.execute-api.<region>.amazonaws.com/live
  live_url = "${aws_apigatewayv2_api.live.api_endpoint}/${local.live_stage}"
}
