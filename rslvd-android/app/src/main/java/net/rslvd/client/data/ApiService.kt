package net.rslvd.client.data

import retrofit2.Response
import retrofit2.http.Body
import retrofit2.http.DELETE
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.Path
import retrofit2.http.Query
import okhttp3.ResponseBody

interface ApiService {
    @POST("auth/login")
    suspend fun login(@Body body: LoginRequest): Response<AuthResponse>

    @POST("auth/register")
    suspend fun register(@Body body: RegisterRequest): Response<AuthResponse>

    @GET("auth/me")
    suspend fun me(): Response<User>

    @GET("hosts")
    suspend fun hosts(): Response<List<Host>>

    @GET("update")
    suspend fun updateHostIp(@Query("key") key: String, @Query("ip") ip: String): Response<ResponseBody>

    @POST("hosts")
    suspend fun createHost(@Body body: CreateHostRequest): Response<Host>

    @DELETE("hosts/{id}")
    suspend fun deleteHost(@Path("id") id: String): Response<GenericResponse>

    @GET("tunnels")
    suspend fun tunnels(): Response<List<Tunnel>>

    @POST("tunnels")
    suspend fun createTunnel(@Body body: CreateTunnelRequest): Response<Tunnel>

    @DELETE("tunnels/{id}")
    suspend fun deleteTunnel(@Path("id") id: String): Response<GenericResponse>

    @GET("billing/plans")
    suspend fun plans(): Response<List<PlanInfo>>

    @GET("billing/subscription")
    suspend fun subscription(): Response<SubscriptionInfo>

    @POST("billing/cancel")
    suspend fun cancelSubscription(): Response<GenericResponse>

    @GET("support")
    suspend fun tickets(): Response<List<SupportTicket>>

    @POST("support")
    suspend fun createTicket(@Body body: CreateTicketRequest): Response<SupportTicket>

    @GET("support/{id}")
    suspend fun ticket(@Path("id") id: Int): Response<TicketDetail>

    @POST("support/{id}/reply")
    suspend fun replyTicket(@Path("id") id: Int, @Body body: TicketReplyRequest): Response<TicketMessage>

    @POST("support/{id}/escalate")
    suspend fun escalateTicket(@Path("id") id: Int): Response<SupportTicket>

    @POST("account/delete")
    suspend fun deleteAccount(@Body body: DeleteAccountRequest): Response<GenericResponse>
}
