/*
 * JavaScript functions for providing OpenID Connect with NGINX Plus
 * 
 * Uses keyval as a local token cache, with opaque token sent to the client
 * Refresh token is used to obtain a new JWT transparently
 *
 * Copyright (C) 2019 Nginx, Inc.
 */

function oidcCodeExchange(r) {
    // First check that we received an authorization code from the IdP
    if (r.variables.arg_code.length == 0) {
        if (r.variables.arg_error) {
            r.error("OIDC error receiving authorization code from IdP: " + r.variables.arg_error_description);
        } else {
            r.error("OIDC expected authorization code from IdP but received: " + r.variables.uri);
        }
        r.return(502);
        return;
    }

    // Pass the authorization code to the /_token location so that it can be
    // proxied to the IdP in exchange for a JWT
    r.subrequest("/_token", "code=" + r.variables.arg_code,
        function(reply) {
            if (reply.status == 504) {
                r.error("OIDC timeout connecting to IdP when sending authorization code");
                r.return(504);
                return;
            }

            if (reply.status != 200) {
                try {
                    var errorset = JSON.parse(reply.responseBody);
                    if (errorset.error) {
                        r.error("OIDC error from IdP when sending authorization code: " + errorset.error + ", " + errorset.error_description);
                    } else {
                        r.error("OIDC unexpected response from IdP when sending authorization code (HTTP " + reply.status + "). " + reply.responseBody);
                    }
                } catch (e) {
                    r.error("OIDC unexpected response from IdP when sending authorization code (HTTP " + reply.status + "). " + reply.responseBody);
                }
                r.return(502);
                return;
            }

            // Code exchange returned 200, check for errors
            try {
                var tokenset = JSON.parse(reply.responseBody);
                if (tokenset.error) {
                    r.error("OIDC " + tokenset.error + " " + tokenset.error_description);
                    r.return(500);
                    return;
                }

                // Send the ID Token to auth_jwt location for validation
                r.subrequest("/_id_token_validation", "token=" + tokenset.id_token,
                    function(reply) {
                        if (reply.status != 204) {
                            r.return(500); // validateIdToken() will log errors
                            return;
                        }
                        // ID Token is valid

                        // If the response includes a refresh token then store it
                        if (tokenset.refresh_token) {
                            r.variables.new_refresh = tokenset.refresh_token; // Create key-value store entry
                            r.log("OIDC refresh token stored");
                        } else {
                            r.warn("OIDC no refresh token");
                        }

                        // Add opque token to keyval session store
                        r.log("OIDC success, creating session " + r.variables.request_id);
                        r.variables.new_session = tokenset.id_token; // Create key-value store entry
                        r.return(302, r.variables.cookie_auth_redir);
                   }
                );
            } catch (e) {
                r.error("OIDC authorization code sent but token response is not JSON. " + reply.responseBody);
                r.return(502);
            }
        }
    );
}

function oidcRefreshRequest(r) {
    // Pass the refresh token to the /_refresh location so that it can be
    // proxied to the IdP in exchange for a new id_token
    r.subrequest("/_refresh", "token=" + r.variables.refresh_token,
        function(reply) {
            if (reply.status != 200) {
                // Refresh request failed, log the reason
                var error_log = "OIDC refresh failure";
                if (reply.status == 504) {
                    error_log += ", timeout waiting for IdP";
                } else if (reply.status = 400) {
                    try {
                        var errorset = JSON.parse(reply.responseBody);
                        error_log += ": " + errorset.error + " " + errorset.error_description;
                    } catch (e) {
                        error_log += ": " + reply.responseBody;
                    }
                } else {
                    error_log += " "  + reply.status;
                }
                r.error(error_log);

                // Clear the refresh token, try again
                r.variables.refresh_token = "-";
                r.return(302, r.variables.request_uri);
                return;
            }

            // Refresh request returned 200, check response
            try {
                var tokenset = JSON.parse(reply.responseBody);
                if (!tokenset.id_token) {
                    r.error("OIDC refresh response did not include id_token");
                    if (tokenset.error) {
                        r.error("OIDC " + tokenset.error + " " + tokenset.error_description);
                    }
                    r.variables.refresh_token = "-";
                    r.return(302, r.variables.request_uri);
                    return;
                }

                // Send the new ID Token to auth_jwt location for validation
                r.subrequest("/_id_token_validation", "token=" + tokenset.id_token,
                    function(reply) {
                        if (reply.status != 204) {
                            r.variables.refresh_token = "-";
                            r.return(302, r.variables.request_uri);
                            return;
                        }

                        // ID Token is valid, update keyval
                        r.log("OIDC refresh success, updating id_token");
                        r.variables.session_jwt = tokenset.id_token; // Update key-value store

                        // Update refresh token (if we got a new one)
                        if (r.variables.refresh_token != tokenset.refresh_token) {
                            r.log("OIDC replacing previous refresh token (" + r.variables.refresh_token + ") with new value: " + tokenset.refresh_token);
                            r.variables.refresh_token = tokenset.refresh_token; // Update key-value store
                        }

                        r.internalRedirect(r.variables.request_uri); // Continue processing original request
                    }
                );
            } catch (e) {
                r.variables.refresh_token = "-";
                r.return(302, r.variables.request_uri);
                return;
            }
        }
    );
}

function hashRequestId(r) {
    var c = require('crypto');
    var h = c.createHmac('sha256', r.variables.oidc_hmac_key).update(r.variables.request_id);
    return h.digest('base64url');
}

function validateIdToken(r) {
    // Check mandatory claims
    var required_claims = ["aud", "iat", "iss", "sub"];
    var missing_claims = [];
    for (var i in required_claims) {
        if (r.variables["jwt_claim_" + required_claims[i]].length == 0 ) {
            missing_claims.push(required_claims[i]);
        }
    }
    if (missing_claims.length) {
        r.error("OIDC ID Token validation error: missing claim(s) " + missing_claims.join(" "));
        r.return(403);
        return;
    }
    var valid_token = true;

    // Check iat is a positive integer
    var iat = Math.floor(Number(r.variables.jwt_claim_iat));
    if (String(iat) != r.variables.jwt_claim_iat || iat < 1) {
        r.error("OIDC ID Token validation error: iat claim is not a valid number");
        valid_token = false;
    }

    // Audience matching
    if (r.variables.jwt_claim_aud != r.variables.oidc_client) {
        r.error("OIDC ID Token validation error: aud claim (" + r.variables.jwt_claim_aud + ") does not match configured $oidc_client (" + r.variables.oidc_client + ")");
        valid_token = false;
    }

    // If we receive a nonce in the ID Token then we will use the auth_nonce cookies
    // to check that the JWT can be validated as being directly related to the
    // original request by this client. This mitigates against token replay attacks.
    if (r.variables.refresh_token) {
        r.log("OIDC refresh process skipping nonce validation");
    } else {
        var client_nonce_hash = "";
        if (r.variables.cookie_auth_nonce) {
            var c = require('crypto');
            var h = c.createHmac('sha256', r.variables.oidc_hmac_key).update(r.variables.cookie_auth_nonce);
            client_nonce_hash = h.digest('base64url');
        }
        if (r.variables.jwt_claim_nonce != client_nonce_hash) {
            r.error("OIDC ID Token validation error: nonce from token (" + r.variables.jwt_claim_nonce + ") does not match client (" + client_nonce_hash + ")");
            valid_token = false;
        }
    }

    if (valid_token) {
        r.return(204);
    } else {
        r.return(403);
    }
}
