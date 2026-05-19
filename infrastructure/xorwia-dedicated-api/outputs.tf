output "api_endpoint" {
  value = aws_apigatewayv2_api.xorwia_api.api_endpoint
}
output "green_url" {
  value = "${aws_apigatewayv2_api.xorwia_api.api_endpoint}/green/api/tracefix/debug"
}
output "blue_url" {
  value = "${aws_apigatewayv2_api.xorwia_api.api_endpoint}/blue/api/tracefix/debug"
}
