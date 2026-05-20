resource "aws_apigatewayv2_api" "xorwia_api" {
  name          = "xorwia-nova-http-api"
  protocol_type = "HTTP"
  description   = "Dedicated additive HTTP API for TraceFix validation"

  tags = {
    Project     = "xorwia-tracefix"
    Environment = "green-validation"
    ManagedBy   = "terraform"
    Isolation   = "additive-only"
  }
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.xorwia_api.id
  name        = "$default"
  auto_deploy = true
}

resource "aws_apigatewayv2_integration" "green" {
  api_id             = aws_apigatewayv2_api.xorwia_api.id
  integration_type   = "AWS_PROXY"
  integration_uri    = "arn:aws:apigateway:${var.aws_region}:lambda:path/2015-03-31/functions/arn:aws:lambda:${var.aws_region}:${var.account_id}:function:${var.lambda_function_name}:green/invocations"
  integration_method = "POST"

  request_parameters = {
    "overwrite:path" = "/$request.path.proxy"
  }
}

resource "aws_apigatewayv2_integration" "blue" {
  api_id             = aws_apigatewayv2_api.xorwia_api.id
  integration_type   = "AWS_PROXY"
  integration_uri    = "arn:aws:apigateway:${var.aws_region}:lambda:path/2015-03-31/functions/arn:aws:lambda:${var.aws_region}:${var.account_id}:function:${var.lambda_function_name}:blue/invocations"
  integration_method = "POST"

  request_parameters = {
    "overwrite:path" = "/$request.path.proxy"
  }
}

resource "aws_apigatewayv2_route" "green" {
  api_id    = aws_apigatewayv2_api.xorwia_api.id
  route_key = "ANY /green/{proxy+}"
  target    = "integrations/${aws_apigatewayv2_integration.green.id}"
}

resource "aws_apigatewayv2_route" "blue" {
  api_id    = aws_apigatewayv2_api.xorwia_api.id
  route_key = "ANY /blue/{proxy+}"
  target    = "integrations/${aws_apigatewayv2_integration.blue.id}"
}

resource "aws_lambda_permission" "green_allow" {
  statement_id  = "AllowExecutionFromXorwiaAPIGreen"
  action        = "lambda:InvokeFunction"
  function_name = var.lambda_function_name
  qualifier     = "green"
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.xorwia_api.execution_arn}/*/*"
}

resource "aws_lambda_permission" "blue_allow" {
  statement_id  = "AllowExecutionFromXorwiaAPIBlue"
  action        = "lambda:InvokeFunction"
  function_name = var.lambda_function_name
  qualifier     = "blue"
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.xorwia_api.execution_arn}/*/*"
}
